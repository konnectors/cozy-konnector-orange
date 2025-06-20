/* eslint-disable no-console */

import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'
import ky from 'ky/umd'
import XhrInterceptor from './interceptor'
import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'

const log = Minilog('ContentScript')
Minilog.enable('orangeCCC')

const ORANGE_SPECIAL_HEADERS = {
  'X-Orange-Origin-Id': 'ECQ',
  'X-Orange-Caller-Id': 'ECQ'
}
const PDF_HEADERS = {
  Accept: 'application/pdf',
  'Content-Type': 'application/pdf'
}

const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json'
}

const ERROR_URL = 'https://e.orange.fr/error403.html?ref=idme-ssr&status=error'
const BASE_URL = 'https://www.orange.fr/portail'
const DEFAULT_PAGE_URL = 'https://espace-client.orange.fr/accueil'
let FORCE_FETCH_ALL = false
// For test purpose
// let FORCE_FETCH_ALL = true
const interceptor = new XhrInterceptor()
interceptor.init()

class OrangeContentScript extends ContentScript {
  // ///////
  // PILOT//
  // ///////
  async onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      const { login, password } = payload || {}
      // When the user has chosen mobileConnect option, there is no password request
      // So wee need to check both separatly to ensure we got at least the user login
      if (login) {
        this.store.userCredentials = { ...this.store.userCredentials, login }
      }
      if (password) {
        this.store.userCredentials = { ...this.store.userCredentials, password }
      } else {
        this.log('warn', 'Did not manage to intercept credentials')
      }
    }
  }

  async onWorkerReady() {
    function addClickListener() {
      document.body.addEventListener('click', e => {
        const clickedElementId = e.target.getAttribute('id')
        const clickedElementContent = e.target.textContent
        if (
          clickedElementId === 'btnSubmit' &&
          clickedElementContent !== 'Continuer'
        ) {
          const login = document.querySelector(
            `span[data-testid="user-login"]`
          )?.textContent
          const password = document.querySelector('#password')?.value
          this.bridge.emit('workerEvent', {
            event: 'loginSubmit',
            payload: { login, password }
          })
        }
      })
    }
    // Necessary here for the interception to cover every known scenarios
    // Doing so we ensure if the logout leads to the password step that the listener won't start until the user has filled up the login
    await this.waitForDomReady()
    if (
      !(await this.checkForElement('#remember')) &&
      (await this.checkForElement('span[data-testid="user-login"]'))
    ) {
      this.log(
        'warn',
        'Cannot find the rememberMe checkbox, logout might not work as expected'
      )
    } else {
      const checkBox = document.querySelector('#remember')
      if (checkBox) {
        checkBox.click()
        // Setting the visibility to hidden on the parent to make the element disapear
        // preventing users to click it
        checkBox.parentNode.parentNode.style.visibility = 'hidden'
      }
    }
    this.log('info', 'adding listener')
    addClickListener.bind(this)()
  }

  async PromiseRaceWithError(promises, msg) {
    try {
      this.log('debug', msg)
      await Promise.race(promises)
    } catch (err) {
      this.log('error', err.message)
      throw new Error(`${msg} failed to meet conditions`)
    }
  }

  /**
   * Sometimes, depending on the device, [data-testid="choose-other-account"] may not be clickable yet
   * we click on it until it disappears
   */
  async waitForUndefinedLabelReallyClicked() {
    await waitFor(
      function clickOnElementUntilItDisapear() {
        const elem = document.querySelector(
          '[data-testid=choose-other-account]'
        )
        if (elem) {
          elem.click()
          return false
        }
        return true
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 30 * 1000,
          message: new TimeoutError(
            `waitForUndefinedLabelReallyClicked timed out after ${30 * 1000}ms`
          )
        }
      }
    )
    return true
  }

  async ensureAuthenticated({ account }) {
    this.log('info', '🤖 ensureAuthenticated starts')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    await this.goto(BASE_URL)
    await this.runInWorkerUntilTrue({
      method: 'waitForNextState',
      args: [false],
      timeout: 30 * 1000
    })
    const wantedUserId = (await this.getCredentials())?.userId
    const currentUserId = await this.evaluateInWorker(
      () => window.o_idzone?.USER_DEFINED_MSISDN
    )
    const shouldChangeCurrentAccount =
      !account || currentUserId == null || wantedUserId !== currentUserId
    if (shouldChangeCurrentAccount) {
      await this.ensureNotAuthenticated()
      await this.waitForUserAuthentication()
    } else {
      this.log('debug', 'current user is the expected one, no need to logout')
    }
    return true
  }

  async getContracts() {
    return interceptor.userInfos.portfolio.contracts
      .map(contract => ({
        vendorId: contract.cid,
        brand: contract.brand.toLowerCase(),
        label: contract.offerName.match(/\d{1,3},\d{2}€/)
          ? contract.offerName.replace(/\s\d{1,3},\d{2}€/, '')
          : contract.offerName,
        type: contract.vertical.toLowerCase() === 'mobile' ? 'phone' : 'isp',
        holder: contract.holder,
        number: contract.telco.publicNumber
      }))
      .filter(contract => contract.brand === 'orange')
  }

  getCurrentState() {
    const isErrorUrl = window.location.href.includes('error')
    // Verify if element is present AND if its value is empty as it is now present on passwordPage and have the user's login as value
    const isLoginPage = document.querySelector('#login')?.value === ''

    const isPasswordAlone = Boolean(
      document.querySelector('#password') && !isLoginPage
    )
    const isAccountList = Boolean(
      document.querySelector('[data-testid=choose-other-account]')
    )
    const isReloadButton = Boolean(
      document.querySelector('button[data-testid="button-reload"]')
    )
    const isKeepConnected = Boolean(
      document.querySelector('button[data-testid="button-keepconnected"]')
    )
    const isCaptcha = Boolean(
      document.querySelector('div[class*="captcha_responseContainer"]')
    )
    const isMobileconnect = document.querySelector(
      'button[data-testid="submit-mc"]'
    )
    const elcosHeader = document.querySelector('#o-header > elcos-header')
    const isConnected = elcosHeader
      ? Boolean(
          elcosHeader.shadowRoot.querySelector(
            '[data-oevent-action=sedeconnecter]'
          )
        )
      : false
    const isDisconnected = elcosHeader
      ? Boolean(
          elcosHeader.shadowRoot.querySelector(
            '[data-oevent-action="seconnecter"]'
          )
        )
      : false
    const isConsentPage = Boolean(
      document.querySelector('#didomi-notice-disagree-button')
    )
    if (isErrorUrl) return 'errorPage'
    else if (isLoginPage) return 'loginPage'
    else if (isConnected) return 'connected'
    else if (isPasswordAlone) return 'passwordAlonePage'
    else if (isCaptcha) return 'captchaPage'
    else if (isKeepConnected) return 'keepConnectedPage'
    else if (isAccountList) return 'accountListPage'
    else if (isMobileconnect) return 'mobileConnectPage'
    else if (isReloadButton) return 'reloadButtonPage'
    else if (isDisconnected) return 'disconnectedPage'
    else if (isConsentPage) return 'consentPage'
    else return false
  }

  async triggerNextState(currentState) {
    this.log('info', '📍️ triggerNextState starts')
    if (currentState === 'errorPage') {
      this.log('error', `Got an error page: ${window.location.href}`)
      throw new Error(`VENDOR_DOWN`)
    } else if (currentState === 'consentPage') {
      await this.runInWorker('click', '#didomi-notice-disagree-button')
    } else if (currentState === 'loginPage') {
      return true
    } else if (currentState === 'connected') {
      await this.evaluateInWorker(() => {
        document
          .querySelector('#o-header > elcos-header')
          .shadowRoot.querySelector('[data-oevent-action=sedeconnecter]')
          .click()
      })
    } else if (
      currentState === 'passwordAlonePage' ||
      currentState === 'mobileConnectPage'
    ) {
      await this.waitForElementInWorker('[data-testid=change-account]')
      await this.runInWorker('click', '[data-testid=change-account]')
    } else if (currentState === 'captchaPage') {
      await this.handleCaptcha()
    } else if (currentState === 'keepConnectedPage') {
      await this.runInWorker(
        'click',
        'button[data-testid="button-keepconnected"]'
      )
    } else if (currentState === 'accountListPage') {
      await this.runInWorkerUntilTrue({
        method: 'waitForUndefinedLabelReallyClicked',
        timeout: 10 * 1000
      })
    } else if (currentState === 'reloadButtonPage') {
      await this.runInWorker('click', 'button[data-testid="button-reload"]')
    } else if (currentState === 'disconnectedPage') {
      await this.evaluateInWorker(() => {
        document
          .querySelector('#o-header > elcos-header')
          .shadowRoot.querySelector('[data-oevent-action=seconnecter]')
          .click()
      })
    } else {
      throw new Error(`Unknown page state: ${currentState}`)
    }
  }

  async waitForNextState(previousState) {
    let currentState
    await waitFor(
      () => {
        currentState = this.getCurrentState()
        this.log('info', 'waitForNextState: currentState ' + currentState)
        if (currentState === false) return false
        const result = previousState !== currentState
        return result
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 30 * 1000,
          message: new TimeoutError(
            `waitForNextState timed out after ${
              30 * 1000
            }ms waiting for a state different from ${previousState}`
          )
        }
      }
    )
    return currentState
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated starts')
    await this.goto(BASE_URL)
    await this.runInWorkerUntilTrue({
      method: 'waitForNextState',
      args: [false],
      timeout: 30 * 1000
    })
    const start = Date.now()
    let state = await this.runInWorker('getCurrentState')
    while (state !== 'loginPage') {
      this.log('debug', `current state: ${state}`)
      if (Date.now() - start > 300 * 1000) {
        throw new Error('ensureNotAuthenticated took more than 5m')
      }
      await this.triggerNextState(state)
      state = await this.runInWorkerUntilTrue({
        method: 'waitForNextState',
        args: [state],
        timeout: 20 * 1000
      })
    }
    return true
  }

  async checkAuthenticated() {
    const isGoodUrl = document.location.href.includes(BASE_URL)
    const elcosHeader = document.querySelector('#o-header > elcos-header')
    const isConnectedElementPresent = elcosHeader
      ? Boolean(
          elcosHeader.shadowRoot.querySelector(
            '[data-oevent-action=sedeconnecter]'
          )
        )
      : false
    const isDisconnectElementPresent = elcosHeader
      ? Boolean(
          elcosHeader.shadowRoot.querySelector(
            '[data-oevent-action=identifiezvous]'
          )
        )
      : false
    if (isGoodUrl) {
      if (isConnectedElementPresent) {
        this.log('info', 'Check Authenticated succeeded')
        return true
      }
      if (isDisconnectElementPresent) {
        this.log('info', 'Active session found, returning true')
        return true
      }
    }
    return false
  }

  async autoFill(credentials) {
    const loginInput = document.querySelector('#login')
    let passwordInput = document.querySelector('#password')
    let mobileConnectSumbit = document.querySelector(
      'button[data-testid="submit-mc"]'
    )
    if (credentials.login && loginInput && !passwordInput) {
      // Fully simulate React event to bypass orange's verifications
      await this.dispatchReactEvent(loginInput, credentials.login)
      // Waiting for both password input or mobileConnect submit button
      await this.waitForElementNoReload(
        '#password, button[data-testid="submit-mc"]'
      )
      this.log('debug', 'Password input or MCSubmit button showed up')
    }
    // check presence again in case the login autoFill has been done
    passwordInput = document.querySelector('#password')
    mobileConnectSumbit = document.querySelector(
      'button[data-testid="submit-mc"]'
    )
    this.log('debug', `Password input : ${Boolean(passwordInput)}`)
    this.log('debug', `MCSubmit button : ${Boolean(mobileConnectSumbit)}`)
    if (credentials.password && passwordInput && !mobileConnectSumbit) {
      await this.dispatchReactEvent(passwordInput, credentials.password)
    }
  }

  async dispatchReactEvent(targetInput, credential) {
    this.log('info', '📍️ dispatchReactEvent starts')
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set
    targetInput.focus()
    targetInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    targetInput.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    targetInput.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // set value via native setter
    nativeInputValueSetter.call(targetInput, credential)
    // dispatch input event React-style
    const event = new Event('input', { bubbles: true })
    event.simulated = true // React checks for this
    targetInput.dispatchEvent(event)
  }

  async waitForUserAuthentication() {
    this.log('info', '🤖 waitForUserAuthentication start')
    await this.setWorkerState({ visible: true })
    const credentials = await this.getCredentials()
    this.runInWorker('autoFill', credentials)
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    if (this.store.userCredentials) {
      this.store.userCredentials.userId = await this.evaluateInWorker(
        () => window.o_idzone?.USER_DEFINED_MSISDN
      )
    }
    await this.setWorkerState({ visible: false })
  }

  async waitForErrorUrl() {
    await this.runInWorkerUntilTrue({
      method: 'checkErrorUrl',
      timeout: 10 * 1000
    })
    this.log('error', `Found error url: ${ERROR_URL}`)
    throw new Error('VENDOR_DOWN')
  }

  async checkErrorUrl() {
    await waitFor(
      () => {
        return window.location.href === ERROR_URL
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 30 * 1000,
          message: new TimeoutError(
            `waitForErrorUrl timed out after ${30 * 1000}ms`
          )
        }
      }
    )
    return true
  }

  async handleCaptcha() {
    this.log('info', '📍️ handleCaptcha starts')
    const { askForCaptcha, captchaUrl } = await this.runInWorker(
      'checkForCaptcha'
    )
    if (askForCaptcha) {
      this.log('info', 'captcha found, waiting for resolution')
      await this.waitForUserAction(captchaUrl)
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch start')
    const { forceFullSync, distanceInDays } = await this.shouldFullSync(context)
    if (forceFullSync) {
      FORCE_FETCH_ALL = true
    }
    this.log(
      'info',
      `shouldFullSync : ${JSON.stringify({
        forceFullSync,
        distanceInDays
      })}`
    )
    if (this.store.userCredentials != undefined) {
      await this.saveCredentials(this.store.userCredentials)
    }
    await this.goto(DEFAULT_PAGE_URL)
    await this.waitForElementInWorker('ecm-section-bill')
    const contracts = await this.runInWorker('getContracts')
    for (const contract of contracts) {
      const { recentBills, oldBillsUrl } = await this.fetchRecentBills(
        contract.vendorId,
        distanceInDays
      )
      await this.saveBills(recentBills, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'application/pdf',
        subPath: `${contract.number} - ${contract.label} - ${contract.vendorId}`,
        qualificationLabel:
          contract.type === 'phone' ? 'phone_invoice' : 'isp_invoice'
      })
      // Due to recent changes in Orange's way to handle contracts
      // oldbillsUrl might not be present in the intercepted response
      // Perhaps it will appears differently if it does (when newly created contract will have an history to show)
      // Fortunately the account we dispose to develop has just been migrated to this new handling so we might be able to do something when it happen
      // const testFullsync = true
      if (forceFullSync && oldBillsUrl) {
        const oldBills = await this.fetchOldBills({
          oldBillsUrl,
          vendorId: contract.vendorId
        })
        await this.saveBills(oldBills, {
          context,
          fileIdAttributes: ['vendorRef'],
          contentType: 'application/pdf',
          subPath: `${contract.number} - ${contract.label} - ${contract.vendorId}`,
          qualificationLabel:
            contract.type === 'phone' ? 'phone_invoice' : 'isp_invoice'
        })
      }
    }

    await this.navigateToPersonalInfos()
    await this.runInWorker('getIdentity')
    await this.saveIdentity({ contact: this.store.infosIdentity })
  }

  async fetchOldBills({ oldBillsUrl, vendorId }) {
    this.log('info', 'fetching old bills')
    const { oldBills } = await this.runInWorker(
      'getOldBillsFromWorker',
      oldBillsUrl
    )
    const cid = vendorId

    const saveBillsEntries = []
    for (const bill of oldBills) {
      const { entityName, partitionKeyName, partitionKeyValue, tecId } = bill
      const amount = bill.amount / 100
      const vendorRef = tecId
      const fileurl = `https://espace-client.orange.fr/ecd_wp/facture/historicPDF?entityName=${entityName}&partitionKeyName=${partitionKeyName}&partitionKeyValue=${partitionKeyValue}&tecId=${tecId}&cid=${cid}`
      saveBillsEntries.push({
        vendor: 'orange.fr',
        date: bill.date,
        amount,
        recurrence: 'monthly',
        vendorRef,
        filename: await this.runInWorker(
          'getFileName',
          bill.date,
          amount,
          vendorRef
        ),
        fileurl,
        requestOptions: {
          headers: {
            ...ORANGE_SPECIAL_HEADERS,
            ...PDF_HEADERS
          }
        },
        fileAttributes: {
          metadata: {
            invoiceNumber: vendorRef,
            contentAuthor: 'orange',
            datetime: bill.date,
            datetimeLabel: 'startDate',
            isSubscription: true,
            startDate: bill.date,
            carbonCopy: true
          }
        }
      })
    }
    return saveBillsEntries
  }

  async fetchRecentBills(vendorId, distanceInDays) {
    await this.goto(
      'https://espace-client.orange.fr/facture-paiement/' + vendorId
    )
    await this.PromiseRaceWithError([
      this.waitForElementInWorker('a[href*="/historique-des-factures"]'),
      // Visible reload button in case of error
      this.waitForElementInWorker(
        `a[href="/facture-paiement/${vendorId}"][data-e2e="fact-shootAgain"]`
      )
    ])
    if (
      await this.isElementInWorker(
        `a[href="/facture-paiement/${vendorId}"][data-e2e="fact-shootAgain"]`
      )
    ) {
      await this.reloadBillsPage(vendorId)
    }
    await this.waitForElementInWorker('a[href*="/historique-des-factures"]')
    await this.runInWorker('click', 'a[href*="/historique-des-factures"]')
    await this.PromiseRaceWithError(
      [
        this.runInWorkerUntilTrue({
          method: 'checkMoreBillsButton',
          timeout: 10 * 1000
        }),
        this.waitForElementInWorker('.alert-icon icon-error-severe'),
        this.waitForElementInWorker(
          '.alert-container alert-container-sm alert-danger mb-0'
        )
      ],
      'fetchRecentBills: show bills history'
    )

    let billsToFetch
    const recentBills = await this.runInWorker('getRecentBillsFromInterceptor')
    const saveBillsEntries = []
    if (!FORCE_FETCH_ALL) {
      const allRecentBills = recentBills.billsHistory.billList
      // FORCE_FETCH_ALL being define priorly, if we're meeting this condition,
      // we just need to look for 3 month back maximum.
      // In order to get the fastest execution possible, we're checking how many months we got to cover since last execution
      // as the website is providing one bill a month in most cases, while special cases will be covered from one month to another.
      let numberToFetch = Math.ceil(distanceInDays / 30)
      this.log(
        'info',
        `Fetching ${numberToFetch} ${numberToFetch > 1 ? 'bills' : 'bill'}`
      )
      billsToFetch = allRecentBills.slice(0, numberToFetch)
    } else {
      this.log('info', 'Fetching all bills')
      billsToFetch = recentBills.billsHistory.billList
    }
    for (const bill of billsToFetch) {
      const amount = bill.amount / 100
      const vendorRef = bill.id || bill.tecId
      saveBillsEntries.push({
        vendor: 'orange.fr',
        date: bill.date,
        amount,
        recurrence: 'monthly',
        vendorRef,
        filename: await this.runInWorker(
          'getFileName',
          bill.date,
          amount,
          vendorRef
        ),
        fileurl:
          'https://espace-client.orange.fr/ecd_wp/facture/v1.0/pdf' +
          bill.hrefPdf,
        requestOptions: {
          headers: {
            ...ORANGE_SPECIAL_HEADERS,
            ...PDF_HEADERS
          }
        },
        fileAttributes: {
          metadata: {
            invoiceNumber: vendorRef,
            contentAuthor: 'orange',
            datetime: bill.date,
            datetimeLabel: 'startDate',
            isSubscription: true,
            startDate: bill.date,
            carbonCopy: true
          }
        }
      })
    }

    // will be used to fetch old bills if needed
    const oldBillsUrl = recentBills.billsHistory.oldBillsHref
    return { recentBills: saveBillsEntries, oldBillsUrl }
  }

  async checkMoreBillsButton() {
    this.log('info', '📍️ checkMoreBillsButton starts')
    await waitFor(
      () => {
        const moreBillsButton = document.querySelector(
          '[data-e2e="bh-more-bills"]'
        )

        if (moreBillsButton) {
          this.log('info', 'moreBillsButton found, returning true')
          return true
        } else {
          this.log('info', 'no moreBillsButton, checking bills length')
          const billsLength = document.querySelectorAll(
            '[data-e2e="bh-bill-table-line"]'
          ).length
          if (billsLength <= 12) {
            this.log('info', '12 or less bills found')
            return true
          }
          return false
        }
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  async navigateToPersonalInfos() {
    this.log('info', 'navigateToPersonalInfos starts')
    if (!(await this.isElementInWorker('#o-identityLink'))) {
      this.log('info', 'Cannot find the identityLinkButton, trying with a goto')
      await this.goto('https://espace-client.orange.fr/compte')
    } else {
      await this.clickAndWait(
        '#o-identityLink',
        'a[data-oevent-action="infospersonnelles"]'
      )
      await this.runInWorker(
        'click',
        'a[data-oevent-action="infospersonnelles"]'
      )
    }
    await this.waitForElementInWorker('p', {
      includesText: 'Infos de contact'
    })
    await this.runInWorker('click', 'p', { includesText: 'Infos de contact' })
    // Using allSettle here because we notice some account did not have adresses registered
    await Promise.all([
      this.waitForElementInWorker(
        'a[data-e2e="btn-contact-info-modifier-votre-identite"]'
      ),
      this.waitForElementInWorker(
        'a[data-e2e="btn-contact-info-phone-modifier"]'
      )
    ])
    // Some users does not have any adresse registered on theur account, we got to treat this separatedly to avoid konnector crashing
    try{
      await this.waitForElementInWorker(
        'a[data-e2e="btn-contact-info-modifier-vos-adresses-postales"]', {timeout: 5000}
      )
    }catch(_){
      // Catch it so it don't crash, no big deal if not available
      this.log('warn', 'Address element is not present on the page')
    }
  }

  async waitForUserAction(url) {
    this.log('info', 'waitForUserAction start')
    await this.setWorkerState({ visible: true, url })
    await this.runInWorkerUntilTrue({ method: 'waitForCaptchaResolution' })
    await this.setWorkerState({ visible: false, url })
  }

  async reloadBillsPage(vendorId) {
    this.log('info', '📍️ reloadBillsPage starts')
    await this.runInWorker(
      'click',
      `a[href="/facture-paiement/${vendorId}"][data-e2e="fact-shootAgain"]`
    )
    await this.PromiseRaceWithError([
      this.waitForElementInWorker('a[href*="/historique-des-factures"]'),
      this.waitForElementInWorker(
        `a[href="/facture-paiement/${vendorId}"][data-e2e="fact-shootAgain"]`
      )
    ])
    if (
      await this.isElementInWorker(
        `a[href="/facture-paiement/${vendorId}"][data-e2e="fact-shootAgain"]`
      )
    ) {
      this.log('warn', 'Website did not load the bills, throwing error')
      throw new Error('VENDOR_DOWN')
    }
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite starts')
    const credentials = await this.getCredentials()
    const credentialsLogin = credentials?.login
    const storeLogin = this.store?.userCredentials?.login

    // prefer credentials over user email since it may not be know by the user
    let sourceAccountIdentifier = credentialsLogin || storeLogin
    if (!sourceAccountIdentifier) {
      sourceAccountIdentifier = await this.runInWorker('getUserMail')
    }

    if (!sourceAccountIdentifier) {
      throw new Error('Could not get a sourceAccountIdentifier')
    }

    return {
      sourceAccountIdentifier: sourceAccountIdentifier
    }
  }

  // ////////
  // WORKER//
  // ////////

  async getOldBillsFromWorker(oldBillsUrl) {
    const OLD_BILLS_URL_PREFIX =
      'https://espace-client.orange.fr/ecd_wp/facture/historicBills'
    const response = await ky.get(OLD_BILLS_URL_PREFIX + oldBillsUrl, {
      headers: {
        ...ORANGE_SPECIAL_HEADERS,
        ...JSON_HEADERS
      }
    })
    this.log('debug', `oldBills response status : ${response.status}`)
    if (response.status === 204) {
      this.log('warn', 'Request status is 204, return no content')
      return { oldBills: [] }
    }
    const jsonBills = await response.json()
    return jsonBills
  }

  async getRecentBillsFromInterceptor() {
    return interceptor.recentBills
  }

  async getUserMail() {
    const foundAddress = window.o_idzone?.USER_MAIL_ADDRESS
    if (!foundAddress) {
      throw new Error(
        'Neither credentials or user mail address found, unexpected page reached'
      )
    }
    return foundAddress
  }

  async getIdentity() {
    this.log('info', '📍️ getIdentity starts')
    const idInfos = interceptor.userInfos?.identification?.identity
    const contactInfos =
      interceptor.userInfos?.identification?.contactInformation
    const addressInfos = interceptor.userInfos.billingAddresses?.[0]
    const mobileNumber =
      contactInfos.mobile?.status === 'valid'
        ? contactInfos.mobile.number
        : null
    const homeNumber =
      contactInfos.landline?.status === 'valid'
        ? contactInfos.landline.number
        : null
    const email =
      contactInfos?.email?.status === 'valid'
        ? contactInfos?.email?.address
        : null

    const address = []
    if (addressInfos) {
      const streetNumber = addressInfos.postalAddress?.streetNumber?.number
      const streetType = addressInfos.postalAddress?.street?.type
      const streetName = addressInfos.postalAddress?.street?.name
      const street =
        streetType && streetName ? `${streetType} ${streetName}` : undefined
      const postCode = addressInfos.postalAddress?.postalCode
      const city = addressInfos.postalAddress?.cityName
      const formattedAddress =
        streetNumber && street && postCode && city
          ? `${streetNumber} ${street} ${postCode} ${city}`
          : undefined
      address.push({
        streetNumber,
        street,
        postCode,
        city,
        formattedAddress
      })
    }
    const infosIdentity = {
      name: {
        givenName: idInfos?.firstName,
        lastName: idInfos?.lastName
      },
      address
    }
    if (email) {
      infosIdentity.email = []
      infosIdentity.email.push({
        address: email
      })
    }
    if (mobileNumber || homeNumber) {
      infosIdentity.phone = []
      if (mobileNumber) {
        infosIdentity.phone.push({
          type: 'mobile',
          number: mobileNumber
        })
      }
      if (homeNumber) {
        infosIdentity.phone.push({
          type: 'home',
          number: homeNumber
        })
      }
    }

    await this.sendToPilot({
      infosIdentity
    })
  }

  checkForCaptcha() {
    const captchaContainer = document.querySelector(
      'div[class*="captcha_responseContainer"]'
    )
    let captchaHref = document.location.href
    if (captchaContainer) {
      return { askForCaptcha: true, captchaHref }
    }
    return false
  }

  async checkCaptchaResolution() {
    const passwordInput = document.querySelector('#password')
    const loginInput = document.querySelector('#login')
    const otherAccountButton = document.querySelector(
      '[data-testid="choose-other-account"]'
    )
    const stayLoggedButton = document.querySelector(
      'button[data-testid="button-keepconnected"]'
    )
    if (passwordInput || loginInput || otherAccountButton || stayLoggedButton) {
      return true
    }
    return false
  }

  async waitForCaptchaResolution() {
    await waitFor(this.checkCaptchaResolution, {
      interval: 1000,
      timeout: 60 * 1000
    })
    return true
  }

  async getFileName(date, amount, vendorRef) {
    const digestId = await hashVendorRef(vendorRef)
    const shortenedId = digestId.substr(0, 5)
    return `${date}_orange_${amount}€_${shortenedId}.pdf`
  }

  async downloadFileInWorker(entry) {
    // overload ContentScript.downloadFileInWorker to be able to check the status of the file. Since not-so-long ago, recent bills on some account are all receiving a 403 error, issue is on their side, either on browser desktop/mobile.
    // This does not affect bills older than one year (so called oldBills) for the moment
    this.log('debug', 'downloading file in worker')
    const response = await fetch(entry.fileurl, {
      headers: {
        ...ORANGE_SPECIAL_HEADERS,
        ...JSON_HEADERS
      }
    })
    const clonedResponse = await response.clone()
    const respToText = await clonedResponse.text()
    if (respToText.match('403 Forbidden')) {
      this.log('warn', 'This file received a 403, check on the website')
      return null
    }
    entry.blob = await response.blob()
    entry.dataUri = await blobToBase64(entry.blob)
    if (entry.dataUri) {
      return entry.dataUri
    }
  }
}

const connector = new OrangeContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getUserMail',
      'getIdentity',
      'checkForCaptcha',
      'waitForCaptchaResolution',
      'getFileName',
      'getRecentBillsFromInterceptor',
      'getOldBillsFromWorker',
      'waitForUndefinedLabelReallyClicked',
      'checkErrorUrl',
      'checkMoreBillsButton',
      'getContracts',
      'waitForNextState',
      'getCurrentState',
      'autoFill'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

async function hashVendorRef(vendorRef) {
  const msgUint8 = new window.TextEncoder().encode(vendorRef) // encode as (utf-8) Uint8Array
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgUint8) // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)) // convert buffer to byte array
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('') // convert bytes to hex string
  return hashHex
}

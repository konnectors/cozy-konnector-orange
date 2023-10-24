/* eslint no-console: off */

import { ContentScript } from 'cozy-clisk/dist/contentscript'

import Minilog from '@cozy/minilog'
import waitFor from 'p-wait-for'
import XhrInterceptor from './interceptor'

const log = Minilog('ContentScript')
Minilog.enable('orangeCCC')

const BASE_URL = 'https://espace-client.orange.fr'
const DEFAULT_PAGE_URL = BASE_URL + '/accueil'
const LOGIN_FORM_PAGE = 'https://login.orange.fr/'

const interceptor = new XhrInterceptor()
interceptor.init()

class OrangeContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm starts')
    await this.goto(LOGIN_FORM_PAGE)
    // Has the website has 2 steps for auth, reaching this page can lead on a full login (login+password)
    // a half login (password) or if you already connected, a "stay connected" button.
    // It can also lead to a captcha page.
    // We are waiting for one of them to show
    await Promise.race([
      this.waitForElementInWorker('#login-label'),
      this.waitForElementInWorker('#password-label'),
      this.waitForElementInWorker('button[data-testid="button-keepconnected"]'),
      this.waitForElementInWorker('div[class*="captcha_responseContainer"]'),
      this.waitForElementInWorker('#undefined-label')
    ])
    const loginLabelPresent = await this.isElementInWorker('#login-label')
    this.log('info', 'loginLabelPresent: ' + loginLabelPresent)
    const passwordLabelPresent = await this.isElementInWorker('#password-label')
    this.log('info', 'passwordLabelPresent: ' + passwordLabelPresent)
    const keepConnectedPresent = await this.isElementInWorker(
      'button[data-testid="button-keepconnected"]'
    )
    this.log('info', 'keepConnectedPresent: ' + keepConnectedPresent)
    const captchaPresent = await this.isElementInWorker(
      'div[class*="captcha_responseContainer"]'
    )
    this.log('info', 'captchaPresent: ' + captchaPresent)
    const undefinedLabelPresent = await this.isElementInWorker(
      '#undefined-label'
    )
    this.log('info', 'undefinedLabelPresent: ' + undefinedLabelPresent)

    const { askForCaptcha, captchaUrl } = await this.runInWorker(
      'checkForCaptcha'
    )
    if (askForCaptcha) {
      this.log('info', 'captcha found, waiting for resolution')
      await this.waitForUserAction(captchaUrl)
    }

    // always choose to login on another account
    const isShowingKeepConnected = await this.isElementInWorker(
      'button[data-testid="button-keepconnected"]'
    )
    this.log('info', 'isShowingKeepConnected: ' + isShowingKeepConnected)
    if (isShowingKeepConnected) {
      await this.clickAndWait('#changeAccountLink', '#undefined-label')
    }

    if (await this.isElementInWorker('#undefined-label')) {
      await this.clickAndWait('#undefined-label', '#login-label')
    }
  }

  async ensureAuthenticated() {
    this.log('info', '🤖 ensureAuthenticated starts')
    await this.navigateToLoginForm()
    const credentials = await this.getCredentials()
    if (credentials) {
      this.log('info', 'found credentials, processing')
      await this.tryAutoLogin(credentials)
    } else {
      this.log('info', 'no credentials found, use normal user login')
      await this.waitForUserAuthentication()
    }
    await this.detectSoshOnlyAccount()
  }

  async checkAuthenticated() {
    const loginField = document.querySelector(
      'p[data-testid="selected-account-login"]'
    )
    const passwordField = document.querySelector('#password')
    if (loginField && passwordField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField
      )
      this.log('info', 'Sending user credentials to Pilot')
      this.sendToPilot({
        userCredentials
      })
    }
    const isGoodUrl = document.location.href.includes(
      'https://www.orange.fr/portail'
    )
    const isConnectedRibbonPresent = Boolean(
      document.querySelector('.o-ribbon-is-connected')
    )
    if (isGoodUrl && isConnectedRibbonPresent) {
      this.log('info', 'Check Authenticated succeeded')
      return true
    }
    return false
  }

  async waitForUserAuthentication() {
    this.log('info', 'waitForUserAuthentication start')
    await this.setWorkerState({
      visible: true
    })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    await this.setWorkerState({
      visible: false
    })
  }

  async tryAutoLogin(credentials) {
    this.log('info', 'Trying autologin')
    await this.autoLogin(credentials)
  }

  async autoLogin(credentials) {
    this.log('info', 'Autologin start')
    const emailSelector = '#login'
    const passwordInputSelector = '#password'
    const loginButtonSelector = '#btnSubmit'
    await this.waitForElementInWorker(emailSelector)
    await this.runInWorker('fillingForm', credentials)
    await this.runInWorker('click', loginButtonSelector)

    await Promise.race([
      this.waitForElementInWorker('button[data-testid="button-keepconnected"]'),
      this.waitForElementInWorker(passwordInputSelector)
    ])

    const isShowingKeepConnected = await this.isElementInWorker(
      'button[data-testid="button-keepconnected"]'
    )
    this.log('info', 'isShowingKeepConnected: ' + isShowingKeepConnected)

    if (isShowingKeepConnected) {
      await this.runInWorker(
        'click',
        'button[data-testid="button-keepconnected"]'
      )
      return
    }

    await this.runInWorker('fillingForm', credentials)
    await this.runInWorker('click', loginButtonSelector)
  }

  async fetch(context) {
    this.log('info', '🤖 fetch start')
    if (this.store.userCredentials != undefined) {
      await this.saveCredentials(this.store.userCredentials)
    }
    const billsPage = await this.runInWorkerUntilTrue({
      method: 'checkBillsElement'
    })
    if (!billsPage) {
      this.log('warn', 'Cannot find a path to the bills page')
      throw new Error('Cannot find a path to bill Page, aborting execution')
    }
    this.log('info', ``)
    await this.waitForElementInWorker('a[href*="/historique-des-factures"]')
    await this.runInWorker('click', 'a[href*="/historique-des-factures"]')
    await Promise.race([
      this.waitForElementInWorker('[data-e2e="bh-more-bills"]'),
      this.waitForElementInWorker('.alert-icon icon-error-severe'),
      this.waitForElementInWorker(
        '.alert-container alert-container-sm alert-danger mb-0'
      )
    ])
    const redFrame = await this.runInWorker('checkRedFrame')
    if (redFrame !== null) {
      this.log('warn', 'Website did not load the bills')
      throw new Error('VENDOR_DOWN')
    }
    let recentPdfNumber = await this.runInWorker('getPdfNumber')
    const hasMoreBills = await this.runInWorker('getMoreBillsButton')
    if (hasMoreBills) {
      await this.clickAndWait(
        '[data-e2e="bh-more-bills"]',
        '[aria-labelledby="bp-historicBillsHistoryTitle"]'
      )
    }
    let allPdfNumber = await this.runInWorker('getPdfNumber')
    let oldPdfNumber = allPdfNumber - recentPdfNumber
    await this.convertRecentsToCozyBills(context, recentPdfNumber)
    this.log('info', 'recentPdf loop ended')
    if (oldPdfNumber != 0) {
      await this.convertOldsToCozyBills(context, oldPdfNumber)
      this.log('info', 'oldPdf loop ended, pdfButtons all clicked')
    }
    await this.saveIdentity({
      mailAdress: this.store.infosIdentity.mail,
      // As we're not sure city is present for the running account, we check if it existe in infosIdentity.
      // If it does, then we spread the object containing city, if not, we spread an empty object
      // Resulting in "city" not present in the final identity
      ...(this.store.infosIdentity.city
        ? { city: this.store.infosIdentity.city }
        : {}),
      phoneNumber: this.store.infosIdentity.phoneNumber
    })
    await this.clickAndWait(
      '#o-identityLink',
      'a[data-oevent-action="sedeconnecter"]'
    )
    try {
      await this.clickAndWait(
        'a[data-oevent-action="sedeconnecter"]',
        'a[data-oevent-action="identifiez-vous"]'
      )
    } catch (e) {
      log('error', 'Not completly disconnected, never found the second link')
      throw e
    }
  }

  async convertRecentsToCozyBills(context, recentPdfNumber) {
    for (let i = 0; i < recentPdfNumber; i++) {
      await this.runInWorker('waitForRecentPdfClicked', i)
      let redFrame = await this.runInWorker('checkRedFrame')
      if (redFrame !== null) {
        this.log('warn', 'Website did not load the bills')
        throw new Error('VENDOR_DOWN')
      }
      await this.clickAndWait(
        'a[class="h1 menu-subtitle mb-0 pb-1"]',
        '[data-e2e="bp-tile-historic"]'
      )
      redFrame = await this.runInWorker('checkRedFrame')
      if (redFrame !== null) {
        this.log('warn', 'Website did not load the bills')
        throw new Error('VENDOR_DOWN')
      }
      await this.clickAndWait(
        '[data-e2e="bp-tile-historic"]',
        '[aria-labelledby="bp-billsHistoryTitle"]'
      )
      redFrame = await this.runInWorker('checkRedFrame')
      if (redFrame !== null) {
        this.log('warn', 'Website did not load the bills')
        throw new Error('VENDOR_DOWN')
      }
      await this.clickAndWait(
        '[data-e2e="bh-more-bills"]',
        '[aria-labelledby="bp-historicBillsHistoryTitle"]'
      )
      await this.runInWorker('processingRecentBill')
      this.store.dataUri = []
      for (let i = 0; i < this.store.resolvedBase64.length; i++) {
        let dateArray = this.store.resolvedBase64[i].href.match(
          /([0-9]{4})-([0-9]{2})-([0-9]{2})/g
        )
        this.store.resolvedBase64[i].date = dateArray[0]
        const index = this.store.recentBillsToAdd.findIndex(function (bill) {
          return bill.date === dateArray[0]
        })
        this.store.dataUri.push({
          vendor: 'orange.fr',
          date: this.store.recentBillsToAdd[index].date,
          amount: this.store.recentBillsToAdd[index].amount / 100,
          recurrence: 'monthly',
          vendorRef: this.store.recentBillsToAdd[index].id
            ? this.store.recentBillsToAdd[index].id
            : this.store.recentBillsToAdd[index].tecId,
          filename: await this.runInWorker(
            'getFileName',
            this.store.recentBillsToAdd[index].date,
            this.store.recentBillsToAdd[index].amount / 100,
            this.store.recentBillsToAdd[index].id ||
              this.store.recentBillsToAdd[index].tecId
          ),
          dataUri: this.store.resolvedBase64[i].uri,
          fileAttributes: {
            metadata: {
              invoiceNumber: this.store.recentBillsToAdd[index].id
                ? this.store.recentBillsToAdd[index].id
                : this.store.recentBillsToAdd[index].tecId,
              contentAuthor: 'orange',
              datetime: this.store.recentBillsToAdd[index].date,
              datetimeLabel: 'startDate',
              isSubscription: true,
              startDate: this.store.recentBillsToAdd[index].date,
              carbonCopy: true
            }
          }
        })
      }
      await this.saveBills(this.store.dataUri, {
        context,
        fileIdAttributes: ['filename'],
        contentType: 'application/pdf',
        qualificationLabel: 'isp_invoice'
      })
    }
  }

  async convertOldsToCozyBills(context, oldPdfNumber) {
    for (let i = 0; i < oldPdfNumber; i++) {
      await this.runInWorker('waitForOldPdfClicked', i)
      let redFrame = await this.runInWorker('checkRedFrame')
      if (redFrame !== null) {
        this.log('warn', 'Website did not load the bills')
        throw new Error('VENDOR_DOWN')
      }
      await this.clickAndWait(
        'a[class="h1 menu-subtitle mb-0 pb-1"]',
        '[data-e2e="bp-tile-historic"]'
      )
      redFrame = await this.runInWorker('checkRedFrame')
      if (redFrame !== null) {
        this.log('warn', 'Website did not load the bills')
        throw new Error('VENDOR_DOWN')
      }
      await this.clickAndWait(
        '[data-e2e="bp-tile-historic"]',
        '[aria-labelledby="bp-billsHistoryTitle"]'
      )
      redFrame = await this.runInWorker('checkRedFrame')
      if (redFrame !== null) {
        this.log('warn', 'Website did not load the bills')
        throw new Error('VENDOR_DOWN')
      }
      await this.clickAndWait(
        '[data-e2e="bh-more-bills"]',
        '[aria-labelledby="bp-historicBillsHistoryTitle"]'
      )
      await this.runInWorker('processingOldBill')
      this.store.dataUri = []
      for (let i = 0; i < this.store.resolvedBase64.length; i++) {
        let dateArray = this.store.resolvedBase64[i].href.match(
          /([0-9]{4})-([0-9]{2})-([0-9]{2})/g
        )
        this.store.resolvedBase64[i].date = dateArray[0]
        const index = this.store.oldBillsToAdd.findIndex(function (bill) {
          return bill.date === dateArray[0]
        })
        this.store.dataUri.push({
          vendor: 'orange.fr',
          date: this.store.oldBillsToAdd[index].date,
          amount: this.store.oldBillsToAdd[index].amount / 100,
          recurrence: 'monthly',
          vendorRef: this.store.oldBillsToAdd[index].id
            ? this.store.oldBillsToAdd[index].id
            : this.store.oldBillsToAdd[index].tecId,
          filename: await this.runInWorker(
            'getFileName',
            this.store.oldBillsToAdd[index].date,
            this.store.oldBillsToAdd[index].amount / 100,
            this.store.oldBillsToAdd[index].id ||
              this.store.oldBillsToAdd[index].tecId
          ),
          dataUri: this.store.resolvedBase64[i].uri,
          fileAttributes: {
            metadata: {
              invoiceNumber: this.store.oldBillsToAdd[index].id
                ? this.store.oldBillsToAdd[index].id
                : this.store.oldBillsToAdd[index].tecId,
              contentAuthor: 'orange',
              datetime: this.store.oldBillsToAdd[index].date,
              datetimeLabel: 'startDate',
              isSubscription: true,
              startDate: this.store.oldBillsToAdd[index].date,
              carbonCopy: true
            }
          }
        })
      }
      await this.saveBills(this.store.dataUri, {
        context,
        fileIdAttributes: ['filename'],
        contentType: 'application/pdf',
        qualificationLabel: 'isp_invoice'
      })
    }
  }

  findMoreBillsButton() {
    this.log('info', 'Starting findMoreBillsButton')
    const button = document.querySelector('[data-e2e="bh-more-bills"]')
    if (button) return true
    else return false
  }

  findPdfButtons() {
    this.log('info', 'Starting findPdfButtons')
    const buttons = Array.from(
      document.querySelectorAll('a[class="icon-pdf-file bp-downloadIcon"]')
    )
    return buttons
  }

  findBillsHistoricButton() {
    this.log('info', 'Starting findPdfButtons')
    const button = document.querySelector('[data-e2e="bp-tile-historic"]')
    return button
  }

  findPdfNumber() {
    this.log('info', 'Starting findPdfNumber')
    const buttons = Array.from(
      document.querySelectorAll('a[class="icon-pdf-file bp-downloadIcon"]')
    )
    return buttons.length
  }

  waitForRecentPdfClicked(i) {
    let recentPdfs = document.querySelectorAll(
      '[aria-labelledby="bp-billsHistoryTitle"] a[class="icon-pdf-file bp-downloadIcon"]'
    )
    recentPdfs[i].click()
  }

  waitForOldPdfClicked(i) {
    let oldPdfs = document.querySelectorAll(
      '[aria-labelledby="bp-historicBillsHistoryTitle"] a[class="icon-pdf-file bp-downloadIcon"]'
    )
    oldPdfs[i].click()
  }

  async fillingForm(credentials) {
    if (document.querySelector('#login')) {
      this.log('info', 'filling email field')
      document.querySelector('#login').value = credentials.email
      return
    }
    if (document.querySelector('#password')) {
      this.log('info', 'filling password field')
      document.querySelector('#password').value = credentials.password
      return
    }
  }

  async waitForUserAction(url) {
    this.log('info', 'waitForUserAction start')
    await this.setWorkerState({ visible: true, url })
    await this.runInWorkerUntilTrue({ method: 'waitForCaptchaResolution' })
    await this.setWorkerState({ visible: false, url })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite starts')
    await this.waitForElementInWorker('.o-identityLayer-detail')
    const sourceAccountId = await this.runInWorker('getUserMail')
    if (sourceAccountId === 'UNKNOWN_ERROR') {
      throw new Error('Could not get a sourceAccountIdentifier')
    }
    return {
      sourceAccountIdentifier: sourceAccountId
    }
  }

  async getUserMail() {
    try {
      const result = document.querySelector('.o-identityLayer-detail').innerHTML
      if (result) {
        return result
      }
    } catch (err) {
      if (
        err.message === "Cannot read properties of null (reading 'innerHTML')"
      ) {
        this.log(
          'warn',
          `Error message : ${err.message}, trying to reload page`
        )
        window.location.reload()
        this.log('info', 'Profil homePage reloaded')
      } else {
        this.log('warn', 'Untreated problem encountered')
        return 'UNKNOWN_ERROR'
      }
    }
    return false
  }

  async findAndSendCredentials(loginField) {
    this.log('info', 'getting in findAndSendCredentials')
    let userLogin = loginField.innerHTML
      .replace('<strong>', '')
      .replace('</strong>', '')
    let divPassword = document.querySelector('#password').value
    const userCredentials = {
      email: userLogin,
      password: divPassword
    }

    return userCredentials
  }

  async checkRedFrame() {
    const redFrame = document.querySelector('.alert-icon icon-error-severe')
    const oldBillsRedFrame = document.querySelector(
      '.alert-container alert-container-sm alert-danger mb-0'
    )
    if (redFrame) return redFrame
    if (oldBillsRedFrame) return oldBillsRedFrame
    return null
  }

  async detectSoshOnlyAccount() {
    await this.runInWorker('checkInfosConfirmation')
    await this.waitForElementInWorker(`a[href="${DEFAULT_PAGE_URL}"`)
    await this.goto(DEFAULT_PAGE_URL)
    await this.waitForElementInWorker('strong')
    const isSosh = await this.runInWorker(
      'checkForElement',
      `#oecs__logo[href="https://www.sosh.fr/"]`
    )
    this.log('info', 'isSosh ' + isSosh)
    if (isSosh) {
      throw new Error(
        'This should be an orange account. Found only sosh contracts'
      )
    }
  }

  async getTestEmail() {
    this.log('info', 'Getting in getTestEmail')
    const mail = document.querySelector(
      'p[data-testid="selected-account-login"]'
    )
    const mailList = document.querySelector('ul[data-testid="accounts-list"]')
    if (mail) {
      const testEmail = mail.textContent
      const type = 'mail'
      if (testEmail) {
        return { testEmail, type }
      }
      return null
    }
    if (mailList) {
      const rawMail = mailList.children[0].querySelector('a').getAttribute('id')
      const testEmail = rawMail.split('choose-account-')[1]
      const type = 'mailList'
      if (testEmail) {
        return { testEmail, type }
      }
      return null
    }
  }

  async getMoreBillsButton() {
    this.log('info', 'Getting in getMoreBillsButton')
    let moreBillsButton = this.findMoreBillsButton()
    return moreBillsButton
  }

  async getPdfNumber() {
    this.log('info', 'Getting in getPdfNumber')
    let pdfNumber = this.findPdfNumber()
    return pdfNumber
  }

  async processingRecentBill() {
    let resolvedBase64 = []
    this.log('info', 'Awaiting promises')
    const recentToBase64 = await Promise.all(
      interceptor.recentPromisesToConvertBlobToBase64
    )
    this.log('info', 'Processing promises')
    for (let i = 0; i < recentToBase64.length; i++) {
      resolvedBase64.push({
        uri: recentToBase64[i],
        href: interceptor.recentXhrUrls[i]
      })
    }
    const recentBillsToAdd = interceptor.recentBills[0].billsHistory.billList
    this.log('info', 'billsArray ready, Sending to pilot')
    const infosIdentity = {
      phoneNumber: interceptor.userInfos[0].contracts[0].telco.publicNumber,
      mail: document.querySelector('.o-identityLayer-detail').innerHTML
    }
    // City is not always given, depending of the user and if it's an internet or mobile subscription.
    let city
    if (interceptor.userInfos[0].contracts[0].contractInstallationArea) {
      city = interceptor.userInfos[0].contracts[0].contractInstallationArea.city
      infosIdentity.city = city
    }
    await this.sendToPilot({
      resolvedBase64,
      recentBillsToAdd,
      infosIdentity
    })
    resolvedBase64 = []
  }

  async processingOldBill() {
    let resolvedBase64 = []
    this.log('info', 'Awaiting promises')
    const oldToBase64 = await Promise.all(
      interceptor.oldPromisesToConvertBlobToBase64
    )
    this.log('info', 'Processing promises')
    for (let i = 0; i < oldToBase64.length; i++) {
      resolvedBase64.push({
        uri: oldToBase64[i],
        href: interceptor.oldXhrUrls[i]
      })
    }
    const oldBillsToAdd = interceptor.oldBills[0].oldBills
    this.log('info', 'billsArray ready, Sending to pilot')
    const infosIdentity = {
      phoneNumber: interceptor.userInfos[0].contracts[0].telco.publicNumber,
      mail: document.querySelector('.o-identityLayer-detail').innerHTML
    }
    // City is not always given, depending of the user and if it's an internet or mobile subscription.
    let city
    if (interceptor.userInfos[0].contracts[0].contractInstallationArea) {
      city = interceptor.userInfos[0].contracts[0].contractInstallationArea.city
      infosIdentity.city = city
    }
    await this.sendToPilot({
      resolvedBase64,
      oldBillsToAdd,
      infosIdentity
    })
    resolvedBase64 = []
  }

  checkIfRemember() {
    this.log('info', 'checkIfRemember starts')
    const link = document.querySelector('#changeAccountLink')
    if (link) {
      this.log('info', 'returning true')
      return true
    }
    this.log('info', 'returning false')
    return false
  }

  checkInfosConfirmation() {
    const laterButton = document.querySelector('a[class="btn btn-secondary"]')
    if (laterButton === null) {
      return
    }
    const textInButton = laterButton.textContent
    if (textInButton === 'Ignorer') {
      laterButton.click()
    } else {
      this.log('warn', 'seems like infos confirmation page has changed')
    }
    return
  }

  isElementPresent(selector) {
    return Boolean(document.querySelector(selector))
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
    const stayLoggedButton = document.querySelector(
      'button[data-testid="button-keepconnected"]'
    )
    const otherAccountButton = document.querySelector('#undefined-label')
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

  async checkAccountListPage() {
    const isAccountListPage = Boolean(
      document.querySelector('#undefined-label')
    )
    if (isAccountListPage) return true
    return false
  }

  async findAndClickBillsElement() {
    const strongElements = document.querySelectorAll('strong')
    for (const element of strongElements) {
      if (element.textContent === 'Factures et paiements') {
        this.log('info', '"Factures et paiements" found, clicking it')
        element.click()
        return true
      }
    }
    return false
  }
  async checkBillsElement() {
    await waitFor(this.findAndClickBillsElement.bind(this), {
      interval: 1000,
      timeout: 30 * 1000
    })
    return true
  }

  async getFileName(date, amount, vendorRef) {
    const digestId = await hashVendorRef(vendorRef)
    const shortenedId = digestId.substr(0, 5)
    return `${date}_orange_${amount}€_${shortenedId}.pdf`
  }

  async waitForBillsElement() {
    await waitFor(this.checkBillsElement, {
      interval: 1000,
      timeout: 30 * 1000
    })
    return true
  }
}

const connector = new OrangeContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getUserMail',
      'checkRedFrame',
      'getMoreBillsButton',
      'processingRecentBill',
      'processingOldBill',
      'getTestEmail',
      'fillingForm',
      'getPdfNumber',
      'waitForRecentPdfClicked',
      'waitForOldPdfClicked',
      'checkIfRemember',
      'checkInfosConfirmation',
      'checkForCaptcha',
      'isElementPresent',
      'waitForCaptchaResolution',
      'checkAccountListPage',
      'checkBillsElement',
      'getFileName'
    ]
  })
  .catch(err => {
    log('warn', err)
  })

// Used for debug purposes only
// function sleep(delay) {
//   return new Promise(resolve => {
//     setTimeout(resolve, delay * 1000)
//   })
// }

async function hashVendorRef(vendorRef) {
  const msgUint8 = new window.TextEncoder().encode(vendorRef) // encode as (utf-8) Uint8Array
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgUint8) // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)) // convert buffer to byte array
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('') // convert bytes to hex string
  return hashHex
}

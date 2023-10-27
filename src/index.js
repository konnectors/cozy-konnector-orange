/* eslint no-console: off */

import { ContentScript } from 'cozy-clisk/dist/contentscript'

import Minilog from '@cozy/minilog'
import waitFor from 'p-wait-for'
import XhrInterceptor from './interceptor'
import ky from 'ky/umd'

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
    await this.runInWorker('fillForm', credentials)
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

    await this.runInWorker('fillForm', credentials)
    await this.runInWorker('click', loginButtonSelector)
  }

  async fetch(context) {
    this.log('info', '🤖 fetch start')
    if (this.store.userCredentials != undefined) {
      await this.saveCredentials(this.store.userCredentials)
    }

    const { recentBills, oldBillsUrl } = await this.fetchRecentBills()
    await this.saveBills(recentBills, {
      context,
      fileIdAttributes: ['vendorRef'],
      contentType: 'application/pdf',
      qualificationLabel: 'isp_invoice'
    })
    const oldBills = await this.fetchOldBills({ oldBillsUrl })
    await this.saveBills(oldBills, {
      context,
      fileIdAttributes: ['vendorRef'],
      contentType: 'application/pdf',
      qualificationLabel: 'isp_invoice'
    })

    await this.navigateToPersonalInfos()
    await this.runInWorker('getIdentity')
    await this.saveIdentity({ contact: this.store.infosIdentity })

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

  async fetchOldBills({ oldBillsUrl }) {
    this.log('info', 'fetching old bills')
    const { oldBills } = await this.runInWorker(
      'getOldBillsFromWorker',
      oldBillsUrl
    )
    const cid = oldBillsUrl.split('=').pop()

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

  async getRecentBillsFromInterceptor() {
    return interceptor.recentBills
  }

  async fetchRecentBills() {
    await this.goto(BASE_URL)
    await this.waitForElementInWorker('strong', {
      includesText: 'Factures et paiements'
    })
    await this.runInWorker('click', 'strong', {
      includesText: 'Factures et paiements'
    })
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

    const recentBills = await this.runInWorker('getRecentBillsFromInterceptor')
    const saveBillsEntries = []
    for (const bill of recentBills.billsHistory.billList) {
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

  async navigateToPersonalInfos() {
    this.log('info', 'navigateToPersonalInfos starts')
    await this.clickAndWait(
      '#o-identityLink',
      'a[data-oevent-action="infospersonnelles"]'
    )

    await this.runInWorker('click', 'a[data-oevent-action="infospersonnelles"]')

    await this.waitForElementInWorker('span', {
      includesText: 'Infos personnelles'
    })
    await this.runInWorker('click', 'span', {
      includesText: 'Infos personnelles'
    })
    await Promise.all([
      this.waitForElementInWorker('a[href="/compte/etat-civil"]'),
      this.waitForElementInWorker(
        'a[href="/compte/modification-moyens-contact"]'
      ),
      this.waitForElementInWorker('a[href="/compte/adresse"]')
    ])
  }

  async getIdentity() {
    this.log('info', 'getIdentity starts')
    const addressInfos = interceptor.userInfos[2]?.[0]
    const phoneNumber =
      interceptor.userInfos[0]?.contracts?.[0]?.telco?.publicNumber
    const address = []
    if (addressInfos) {
      address.push({
        houseNumber: addressInfos.postalAddress.streetNumber.number,
        street: `${addressInfos.postalAddress.street.type} ${addressInfos.postalAddress.street.name}`,
        postCode: addressInfos.postalAddress.postalCode,
        city: addressInfos.postalAddress.cityName,
        formattedAddress: `${address.houseNumber} ${address.street} ${address.postCode} ${address.city}`
      })
    }
    const infosIdentity = {
      name: {
        givenName: interceptor.userInfos[0]?.contracts?.[0]?.holder?.firstName,
        lastName: interceptor.userInfos[0]?.contracts?.[0]?.holder?.lastName
      },
      phone: [
        {
          type: phoneNumber.match(/^06|07|\+336|\+337/g) ? 'mobile' : 'home',
          number: phoneNumber
        }
      ],
      mail: interceptor.userInfos[1]?.contactInformation?.email?.address,
      address
    }

    await this.sendToPilot({
      infosIdentity
    })
  }

  async fillForm(credentials) {
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

  async getOldBillsFromWorker(oldBillsUrl) {
    const OLD_BILLS_URL_PREFIX =
      'https://espace-client.orange.fr/ecd_wp/facture/historicBills'
    return await ky
      .get(OLD_BILLS_URL_PREFIX + oldBillsUrl, {
        headers: {
          ...ORANGE_SPECIAL_HEADERS,
          ...JSON_HEADERS
        }
      })
      .json()
  }

  async getFileName(date, amount, vendorRef) {
    const digestId = await hashVendorRef(vendorRef)
    const shortenedId = digestId.substr(0, 5)
    return `${date}_orange_${amount}€_${shortenedId}.pdf`
  }
}

const connector = new OrangeContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getUserMail',
      'checkRedFrame',
      'getTestEmail',
      'fillForm',
      'checkInfosConfirmation',
      'checkForCaptcha',
      'waitForCaptchaResolution',
      'getFileName',
      'getIdentity',
      'getRecentBillsFromInterceptor',
      'getOldBillsFromWorker'
    ]
  })
  .catch(err => {
    log('warn', err)
  })

async function hashVendorRef(vendorRef) {
  const msgUint8 = new window.TextEncoder().encode(vendorRef) // encode as (utf-8) Uint8Array
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgUint8) // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)) // convert buffer to byte array
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('') // convert bytes to hex string
  return hashHex
}

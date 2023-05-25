import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('orangeCCC')

const BASE_URL = 'https://espace-client.orange.fr'
const DEFAULT_PAGE_URL = BASE_URL + '/accueil'
const DEFAULT_SOURCE_ACCOUNT_IDENTIFIER = 'orange'
const LOGIN_FORM_PAGE = 'https://login.orange.fr/'

let recentBills = []
let oldBills = []
let recentPromisesToConvertBlobToBase64 = []
let oldPromisesToConvertBlobToBase64 = []
let recentXhrUrls = []
let oldXhrUrls = []
let userInfos = []

// The override here is needed to intercept XHR requests made during the navigation
// The website respond with an XHR containing a blob when asking for a pdf, so we need to get it and encode it into base64 before giving it to the pilot.
var proxied = window.XMLHttpRequest.prototype.open
// Overriding the open() method
window.XMLHttpRequest.prototype.open = function () {
  var originalResponse = this
  // Intercepting response for recent bills informations.
  if (arguments[1].includes('/users/current/contracts')) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        // The response is a unique string, in order to access information parsing into JSON is needed.
        const jsonBills = JSON.parse(originalResponse.responseText)
        recentBills.push(jsonBills)
      }
    })
    return proxied.apply(this, [].slice.call(arguments))
  }
  // Intercepting response for old bills informations.
  if (arguments[1].includes('/facture/historicBills?')) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        const jsonBills = JSON.parse(originalResponse.responseText)
        oldBills.push(jsonBills)
      }
    })
    return proxied.apply(this, [].slice.call(arguments))
  }
  // Intercepting user infomations for Identity object
  if (arguments[1].includes('ecd_wp/portfoliomanager/portfolio?')) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        const jsonInfos = JSON.parse(originalResponse.responseText)
        userInfos.push(jsonInfos)
      }
    })
    return proxied.apply(this, [].slice.call(arguments))
  }
  // Intercepting response for recent bills blobs.
  if (arguments[1].includes('facture/v1.0/pdf?billDate')) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        // Pushing in an array the converted to base64 blob and pushing in another array it's href to match the indexes.
        recentPromisesToConvertBlobToBase64.push(
          blobToBase64(originalResponse.response)
        )
        recentXhrUrls.push(originalResponse.__zone_symbol__xhrURL)

        // In every case, always returning the original response untouched
        return originalResponse
      }
    })
  }
  // Intercepting response for old bills blobs.
  if (arguments[1].includes('ecd_wp/facture/historicPDF?')) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        oldPromisesToConvertBlobToBase64.push(
          blobToBase64(originalResponse.response)
        )
        oldXhrUrls.push(originalResponse.__zone_symbol__xhrURL)

        return originalResponse
      }
    })
  }
  return proxied.apply(this, [].slice.call(arguments))
}

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
      this.waitForElementInWorker('#oecs__connecte-se-deconnecter'),
      this.waitForElementInWorker('div[class*="captcha_responseContainer"]'),
      this.waitForElementInWorker('#undefined-label')
    ])
    const { askForCaptcha, captchaUrl } = await this.runInWorker(
      'checkForCaptcha'
    )
    if (askForCaptcha) {
      this.log('debug', 'captcha found, waiting for resolution')
      await this.waitForUserAction(captchaUrl)
    }
  }

  async ensureAuthenticated() {
    this.log('info', 'ensureAuthenticated starts')
    await this.navigateToLoginForm()
    const credentials = await this.getCredentials()
    await this.waitForElementInWorker('#o-ribbon')
    if (credentials) {
      this.log('debug', 'found credentials, processing')
      await this.waitForElementInWorker('#o-ribbon')
      await Promise.race([
        this.waitForElementInWorker('p[data-testid="selected-account-login"]'),
        this.waitForElementInWorker('#undefined-label')
      ])
      const { testEmail, type } = await this.runInWorker('getTestEmail')
      if (credentials.email === testEmail) {
        if (type === 'mail') {
          await this.waitForElementInWorker('#o-ribbon')
          await this.tryAutoLogin(credentials, 'half')
          await this.waitForElementInWorker('#o-ribbon-right')
          const stayLogButton = await this.runInWorker('getStayLoggedButton')
          if (stayLogButton != null) {
            stayLogButton.click()
            await this.waitForElementInWorker(
              'div[class="o-ribbon-is-connected"]'
            )
            return true
          } else {
            await this.waitForElementInWorker(
              'div[class="o-ribbon-is-connected"]'
            )
            return true
          }
        }
        if (type === 'mailList') {
          this.log('debug', 'found credentials, trying to autoLog')
          const mailSelector = `a[id="choose-account-${testEmail}"]`
          await this.runInWorker('click', mailSelector)
          await this.tryAutoLogin(credentials, 'half')
          return true
        }
      }

      if (credentials.email != testEmail) {
        this.log('debug', 'getting in different testEmail conditions')
        const isChangeAccountPresent = await this.runInWorker(
          'isElementPresent',
          '#changeAccountLink'
        )
        const isUndefinedPresent = await this.runInWorker(
          'isElementPresent',
          '#undefined-label'
        )
        if (isChangeAccountPresent) {
          await this.clickAndWait('#changeAccountLink', '#undefined-label')
        } else if (!isUndefinedPresent) {
          throw new Error(
            'Unexpected case where neither changeaccount link or undefined account link are presents'
          )
        }
        await this.clickAndWait('#undefined-label', '#login')
        await this.tryAutoLogin(credentials, 'full')
        return true
      }
    }
    if (!credentials) {
      this.log('debug', 'no credentials found, use normal user login')
      const rememberUser = await this.runInWorker('checkIfRemember')
      if (rememberUser) {
        this.log('debug', 'Already visited')
        await this.clickAndWait('#changeAccountLink', '#undefined-label')
        await this.clickAndWait('#undefined-label', '#login')
        await this.waitForUserAuthentication()
        return true
      }
      const isAccountListPage = await this.runInWorker('checkAccountListPage')
      if (isAccountListPage) {
        this.log(
          'debug',
          'Webview on accountsList page, go to first login step'
        )
        await this.runInWorker('click', '#undefined-label')
        await this.waitForElementInWorker('#login-label')
      }
      await this.waitForUserAuthentication()
      return true
    }

    this.log('warn', 'Not authenticated')
    throw new Error('LOGIN_FAILED')
  }

  async ensureNotAuthenticated() {
    this.log('info', 'ensureNotAuthenticated starts')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
    if (
      document.querySelector(
        'button[data-oevent-action="clic_rester_identifie"]'
      )
    ) {
      await this.runInWorker('click', '#changeAccountLink')
      await this.waitForElementInWorker('#undefined-label')
      await this.runInWorker('click', '#undefined-label')
      await this.waitForElementInWorker('#login-label')
    }
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
      this.log('debug', 'Sending user credentials to Pilot')
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
    this.log('debug', 'waitForUserAuthentication start')
    await this.setWorkerState({
      visible: true
    })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    await this.setWorkerState({
      visible: false
    })
  }

  async tryAutoLogin(credentials, type) {
    this.log('info', 'Trying autologin')
    await this.autoLogin(credentials, type)
  }

  async autoLogin(credentials, type) {
    this.log('info', 'Autologin start')
    const emailSelector = '#login'
    const passwordInputSelector = '#password'
    const loginButton = '#btnSubmit'
    if (type === 'half') {
      this.log('info', 'wait for password field')
      await this.waitForElementInWorker(passwordInputSelector)
      await this.runInWorker('fillingForm', credentials)

      await this.runInWorker('click', loginButton)
      await this.waitForElementInWorker('#o-ribbon')
      return true
    }
    await this.waitForElementInWorker(emailSelector)
    await this.runInWorker('fillingForm', credentials)
    await this.runInWorker('click', loginButton)
    this.log('info', 'wait for password field')
    await this.waitForElementInWorker(passwordInputSelector)
    await this.runInWorker('fillingForm', credentials)
    await this.runInWorker('click', loginButton)
  }

  async fetch(context) {
    this.log('info', 'Starting fetch')
    if (this.store.userCredentials != undefined) {
      await this.saveCredentials(this.store.userCredentials)
    }
    await this.runInWorker('checkInfosConfirmation')
    await this.waitForElementInWorker(`a[href="${DEFAULT_PAGE_URL}"`)
    await this.clickAndWait(`a[href="${DEFAULT_PAGE_URL}"`, 'strong')
    const billsPage = await this.runInWorkerUntilTrue({
      method: 'checkBillsElement'
    })
    if (!billsPage) {
      this.log('warn', 'Cannot find a path to the bills page')
      throw new Error('Cannot find a path to bill Page, aborting execution')
    }
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
    await this.clickAndWait(
      '[data-e2e="bh-more-bills"]',
      '[aria-labelledby="bp-historicBillsHistoryTitle"]'
    )
    let allPdfNumber = await this.runInWorker('getPdfNumber')
    let oldPdfNumber = allPdfNumber - recentPdfNumber
    for (let i = 0; i < recentPdfNumber; i++) {
      this.log('info', `Before clicking ${i} recent pdf`)
      await this.runInWorker('waitForRecentPdfClicked', i)
      let redFrame = await this.runInWorker('checkRedFrame')
      if (redFrame !== null) {
        this.log('warn', 'Website did not load the bills')
        throw new Error('VENDOR_DOWN')
      }
      this.log('info', `After clicking ${i} recent pdf`)
      await this.clickAndWait(
        'a[class="h1 menu-subtitle mb-0 pb-1"]',
        '[data-e2e="bp-tile-historic"]'
      )
      redFrame = await this.runInWorker('checkRedFrame')
      if (redFrame !== null) {
        this.log('warn', 'Website did not load the bills')
        throw new Error('VENDOR_DOWN')
      }
      this.log('info', `Back to bill list ${i} recent pdf`)
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
    }
    this.log('info', 'recentPdf loop ended')
    for (let i = 0; i < oldPdfNumber; i++) {
      this.log('info', `Before clicking ${i} old pdf`)
      await this.runInWorker('waitForOldPdfClicked', i)
      let redFrame = await this.runInWorker('checkRedFrame')
      if (redFrame !== null) {
        this.log('warn', 'Website did not load the bills')
        throw new Error('VENDOR_DOWN')
      }
      this.log('info', `After clicking ${i} old pdf`)
      await this.clickAndWait(
        'a[class="h1 menu-subtitle mb-0 pb-1"]',
        '[data-e2e="bp-tile-historic"]'
      )
      redFrame = await this.runInWorker('checkRedFrame')
      if (redFrame !== null) {
        this.log('warn', 'Website did not load the bills')
        throw new Error('VENDOR_DOWN')
      }
      this.log('info', `Back to bill list ${i} old pdf`)
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
    }
    this.log('info', 'oldPdf loop ended, pdfButtons all clicked')
    await this.runInWorker('processingBills')
    this.store.dataUri = []
    for (let i = 0; i < this.store.resolvedBase64.length; i++) {
      let dateArray = this.store.resolvedBase64[i].href.match(
        /([0-9]{4})-([0-9]{2})-([0-9]{2})/g
      )
      this.store.resolvedBase64[i].date = dateArray[0]
      const index = this.store.allBills.findIndex(function (bill) {
        return bill.date === dateArray[0]
      })
      this.store.dataUri.push({
        vendor: 'orange.fr',
        date: this.store.allBills[index].date,
        amount: this.store.allBills[index].amount / 100,
        recurrence: 'monthly',
        vendorRef: this.store.allBills[index].id
          ? this.store.allBills[index].id
          : this.store.allBills[index].tecId,
        filename: await getFileName(
          this.store.allBills[index].date,
          this.store.allBills[index].amount / 100,
          this.store.allBills[index].id || this.store.allBills[index].tecId
        ),
        dataUri: this.store.resolvedBase64[i].uri,
        fileAttributes: {
          metadata: {
            invoiceNumber: this.store.allBills[index].id
              ? this.store.allBills[index].id
              : this.store.allBills[index].tecId,
            contentAuthor: 'orange',
            datetime: this.store.allBills[index].date,
            datetimeLabel: 'startDate',
            isSubscription: true,
            startDate: this.store.allBills[index].date,
            carbonCopy: true
          }
        }
      })
    }
    await this.saveIdentity({
      mailAdress: this.store.infosIdentity.mail,
      city: this.store.infosIdentity.city,
      phoneNumber: this.store.infosIdentity.phoneNumber
    })
    await this.saveBills(this.store.dataUri, {
      context,
      fileIdAttributes: ['filename'],
      contentType: 'application/pdf',
      qualificationLabel: 'isp_invoice'
    })
    await this.clickAndWait(
      '#o-identityLink',
      'a[data-oevent-action="sedeconnecter"]'
    )
    await this.clickAndWait(
      'a[data-oevent-action="sedeconnecter"]',
      'a[data-oevent-action="identifiez-vous"]'
    )
  }

  findMoreBillsButton() {
    this.log('info', 'Starting findMoreBillsButton')
    const button = Array.from(
      document.querySelector('[data-e2e="bh-more-bills"]')
    )
    return button
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

  findStayLoggedButton() {
    this.log('info', 'Starting findStayLoggedButton')
    const button = document.querySelector(
      '[data-oevent-label="bouton_rester_identifie"]'
    )
    return button
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
    await this.waitForElementInWorker('.o-identityLayer-detail')
    const sourceAccountId = await this.runInWorker('getUserMail')
    if (sourceAccountId === 'UNKNOWN_ERROR') {
      this.log('warn', "Couldn't get a sourceAccountIdentifier, using default")
      return { sourceAccountIdentifier: DEFAULT_SOURCE_ACCOUNT_IDENTIFIER }
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

  async getStayLoggedButton() {
    this.log('info', 'Starting getStayLoggedButton')
    const button = this.findStayLoggedButton()
    return button
  }

  async processingBills() {
    let resolvedBase64 = []
    this.log('info', 'Awaiting promises')
    const recentToBase64 = await Promise.all(
      recentPromisesToConvertBlobToBase64
    )
    const oldToBase64 = await Promise.all(oldPromisesToConvertBlobToBase64)
    this.log('info', 'Processing promises')
    const promisesToBase64 = recentToBase64.concat(oldToBase64)
    const xhrUrls = recentXhrUrls.concat(oldXhrUrls)
    for (let i = 0; i < promisesToBase64.length; i++) {
      resolvedBase64.push({
        uri: promisesToBase64[i],
        href: xhrUrls[i]
      })
    }
    const recentBillsToAdd = recentBills[0].billsHistory.billList
    const oldBillsToAdd = oldBills[0].oldBills
    let allBills = recentBillsToAdd.concat(oldBillsToAdd)
    this.log('debug', 'billsArray ready, Sending to pilot')
    const infosIdentity = {
      city: userInfos[0].contracts[0].contractInstallationArea.city,
      phoneNumber: userInfos[0].contracts[0].telco.publicNumber,
      mail: document.querySelector('.o-identityLayer-detail').innerHTML
    }
    await this.sendToPilot({
      resolvedBase64,
      allBills,
      infosIdentity
    })
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

  async waitForCaptchaResolution() {
    const passwordInput = document.querySelector('#password')
    const loginInput = document.querySelector('#login')
    const otherAccountButton = document.querySelector('#undefined-label')
    if (passwordInput || loginInput || otherAccountButton) {
      return true
    }
    return false
  }

  async checkAccountListPage() {
    const isAccountListPage = Boolean(
      document.querySelector('#undefined-label')
    )
    if (isAccountListPage) return true
    return false
  }

  async checkBillsElement() {
    this.log('info', 'checkBillsElement starts')
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
}

const connector = new OrangeContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getUserMail',
      'checkRedFrame',
      'getMoreBillsButton',
      'processingBills',
      'getTestEmail',
      'fillingForm',
      'getPdfNumber',
      'waitForRecentPdfClicked',
      'waitForOldPdfClicked',
      'getStayLoggedButton',
      'checkIfRemember',
      'checkInfosConfirmation',
      'checkForCaptcha',
      'isElementPresent',
      'waitForCaptchaResolution',
      'checkAccountListPage',
      'checkBillsElement'
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

async function getFileName(date, amount, vendorRef) {
  const digestId = await hashVendorRef(vendorRef)
  const shortenedId = digestId.substr(0, 5)
  return `${date}_orange_${amount}€_${shortenedId}.pdf`
}

async function hashVendorRef(vendorRef) {
  const msgUint8 = new window.TextEncoder().encode(vendorRef) // encode as (utf-8) Uint8Array
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgUint8) // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)) // convert buffer to byte array
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('') // convert bytes to hex string
  return hashHex
}

process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://913841dc7a6a44a59bb26b70df222286:34e4ff6001884d0fac9091d4c1fee102@sentry.cozycloud.cc/25'

const secrets = JSON.parse(process.env.COZY_PARAMETERS || '{}').secret
if (secrets && secrets.proxyUrl) {
  process.env.http_proxy = secrets.proxyUrl
  process.env.https_proxy = secrets.proxyUrl
}

const get = require('lodash/get')

const moment = require('moment')
moment.locale('fr')

const {
  log,
  CookieKonnector,
  cozyClient,
  utils,
  errors
} = require('cozy-konnector-libs')

class OrangeConnector extends CookieKonnector {
  async testSession() {
    try {
      if (!this._jar._jar.toJSON().cookies.length) {
        return false
      }
      log('info', 'Testing session')
      await this.getContracts()
    } catch (err) {
      log('warn', err.message)
      log('warn', 'Session failed')
      return false
    }
  }

  async fetch(fields) {
    if (!(await this.testSession())) {
      await this.logIn(fields)
    }

    const contracts = await this.getContracts()
    if (!contracts || contracts.length === 0) {
      log('warn', 'Could not find any valid contract')
      return
    }

    let bills = []
    for (const contract of contracts) {
      let contractBills = []
      try {
        contractBills = await this.getBills(contract)
      } catch (e) {
        // Unknown error that lead to no bill available
        if (e.message && e.message.includes('omoifars-452')) {
          log(
            'debug',
            `Contract #${contracts.indexOf(contract) +
              1} impossible to fetch bills`
          )
          // Jump to next contract
          continue
        } else {
          throw e
        }
      }
      bills = bills.concat(contractBills)
    }
    await this.saveBills(bills, fields.folderPath, {
      timeout: Date.now() + 60 * 1000,
      identifiers: ['orange'],
      sourceAccount: this.accountId,
      sourceAccountIdentifier: fields.login,
      fileIdAttributes: ['contractNumber', 'vendorRef']
    })
    // Deleting old bills and files from this month and 11 older
    await cleanScrapableBillsAndFiles(fields)
    return
  }

  async logIn(fields) {
    try {
      this.request = this.requestFactory({
        json: true,
        cheerio: false
      })
      const resolveWithFullResponse = true

      // Get cookies from login page.
      log('info', 'Get login form')
      let response = await this.request({
        uri: 'https://login.orange.fr/',
        resolveWithFullResponse
      })

      const headers = {
        'x-auth-id': response.headers['x-auth-id'],
        'x-xsrf-token': response.headers['x-xsrf-token']
      }
      const { login, password } = fields

      log('info', 'Send login with first XSRF token...')

      response = await this.request({
        method: 'POST',
        url: 'https://login.orange.fr/front/login',
        headers,
        body: {
          login
        },
        resolveWithFullResponse
      })

      headers['x-xsrf-token'] = response.headers['x-xsrf-token']
      log('info', 'Send password with second XSRF token...')

      const body = await this.request({
        method: 'POST',
        url: 'https://login.orange.fr/front/password',
        headers,
        body: {
          login,
          password
        }
      })

      if (body.stage === 'changePassword') {
        log('warn', 'Password change needed')
        throw new Error('changePassword')
      }

      if (body.credential != null || body.password != null) {
        throw new Error(body.credential || body.password)
      }
    } catch (err) {
      log('error', err)
      if (err && err.message.includes('bloqué')) {
        throw new Error('LOGIN_FAILED.TOO_MANY_ATTEMPTS')
      } else if (err && err.message.includes('un problème technique')) {
        throw new Error(errors.VENDOR_DOWN)
      } else if (err.statusCode === 401) {
        throw new Error(errors.LOGIN_FAILED)
      } else if (err.message === 'changePassword') {
        throw new Error(errors.USER_ACTION_NEEDED)
      } else {
        throw new Error(errors.VENDOR_DOWN)
      }
    }
    log('info', 'Successfully logged in.')
  }

  async getBills(contract) {
    this.request = this.requestFactory({
      json: true,
      cheerio: false,
      headers: {
        'X-Orange-Caller-Id': 'ECQ'
      }
    })
    try {
      const bills = await this.request({
        url: `https://sso-f.orange.fr/omoi_erb/facture/v2.0/billsAndPaymentInfos/users/current/contracts/${contract.contractId}`,
        timeout: 5000
      })
      const contractLabel = getContractLabel(contract)
      if (!get(bills, 'billsHistory.billList')) return []
      return bills.billsHistory.billList.map(bill => ({
        vendorRef: bill.id,
        contractId: contract.contractId,
        contractLabel: contractLabel,
        date: moment(bill.date, 'YYYY-MM-DD').toDate(),
        vendor: 'Orange',
        amount: bill.amount / 100,
        fileurl:
          'https://sso-f.orange.fr/omoi_erb/facture/v1.0/pdf' + bill.hrefPdf,
        filename: getFileName(bill.date, bill.amount / 100)
      }))
    } catch (err) {
      log('error', err.message)
      throw new Error(errors.VENDOR_DOWN)
    }
  }

  async getContracts() {
    this.request = this.requestFactory({
      json: true,
      cheerio: false,
      headers: {
        'X-Orange-Caller-Id': 'ECQ'
      }
    })
    let contracts = (await this.request({
      url:
        'https://sso-f.orange.fr/omoi_erb/portfoliomanager/v2.0/contractSelector/users/current',
      timeout: 5000
    })).contracts
    contracts.filter(doc => {
      return (
        doc.offerName.includes('Livebox') ||
        doc.offerName.includes('Orange') ||
        doc.brand === 'Orange'
      )
    })
    log('debug', `${contracts.length} contracts object found`)
    return contracts
  }
}

const connector = new OrangeConnector({
  // debug: true
})

connector.run()

function getFileName(date, amount) {
  return `${moment(date, 'YYYY-MM-DD').format(
    'YYYYMM'
  )}_orange_${amount.toFixed(2)}€.pdf`
}

function getContractLabel(contract) {
  if (contract.subType === 'mobile') {
    // return the string Mobile ({phone number without spaces})
    return `Mobile (${contract.lineNumber.replace(/\s/g, '')})`
  } else if (contract.type === 'internet') {
    // return the string Internet ({phone number without spaces})
    return `Internet (${contract.lineNumber.replace(/\s/g, '')})`
  } else {
    log(
      'warn',
      `Unknown account type ${contract.type} and subtype ${contract.subType}`
    )
  }
}

function generate12LastOldFilename() {
  let filenameList = []
  for (let i = 0; i < 12; i++) {
    const oldMonth = moment()
      .subtract(i, 'months')
      .format('YYYYMM')
    const filename = oldMonth + '_orange.pdf'
    filenameList.push(filename)
  }
  return filenameList
}

async function cleanScrapableBillsAndFiles(fields) {
  const filenamesToDelete = generate12LastOldFilename()
  const parentDir = await cozyClient.files.statByPath(fields.folderPath)
  const filesAndDirOrange = await utils.queryAll('io.cozy.files', {
    dir_id: parentDir._id
  })
  const filesOrange = filesAndDirOrange.filter(file => file.type === 'file') // Remove directories
  const billsOrange = await utils.queryAll('io.cozy.bills', {
    vendor: 'Orange'
  })
  const filesDeleted = []
  const billsToDelete = []
  for (const file of filesOrange) {
    if (filenamesToDelete.includes(file.name)) {
      filesDeleted.push(file)
      // Deleting file
      await cozyClient.files.trashById(file._id)
      // Deleting bill
      const bill = isABillMatch(file, billsOrange)
      if (bill) {
        billsToDelete.push(bill)
      }
    }
  }
  // Deleting all necessary bills at once
  await utils.batchDelete('io.cozy.bills', billsToDelete)
}

/* Return the first bill matching the file passed
 */
function isABillMatch(file, bills) {
  for (const bill of bills) {
    if (bill.invoice === `io.cozy.files:${file._id}`) {
      return bill
    }
  }
  return false
}

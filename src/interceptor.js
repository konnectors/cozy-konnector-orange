import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'

export default class XhrInterceptor {
  constructor() {
    this.recentBills = []
    this.oldBills = []
    this.recentPromisesToConvertBlobToBase64 = []
    this.oldPromisesToConvertBlobToBase64 = []
    this.recentXhrUrls = []
    this.oldXhrUrls = []
    this.userInfos = []
  }

  init() {
    const self = this
    // The override here is needed to intercept XHR requests made during the navigation
    // The website respond with an XHR containing a blob when asking for a pdf, so we need to get it and encode it into base64 before giving it to the pilot.
    var proxied = window.XMLHttpRequest.prototype.open
    // Overriding the open() method
    window.XMLHttpRequest.prototype.open = function () {
      var originalResponse = this
      // Intercepting response for recent bills informations.
      if (arguments[1]?.includes('/users/current/contracts')) {
        originalResponse.addEventListener('readystatechange', function () {
          if (originalResponse.readyState === 4) {
            // The response is a unique string, in order to access information parsing into JSON is needed.
            const jsonBills = JSON.parse(originalResponse.responseText)
            self.recentBills.push(jsonBills)
          }
        })
        return proxied.apply(this, [].slice.call(arguments))
      }
      // Intercepting response for old bills informations.
      if (arguments[1]?.includes('/facture/historicBills?')) {
        originalResponse.addEventListener('readystatechange', function () {
          if (originalResponse.readyState === 4) {
            const jsonBills = JSON.parse(originalResponse.responseText)
            self.oldBills.push(jsonBills)
          }
        })
        return proxied.apply(this, [].slice.call(arguments))
      }
      // Intercepting user infomations for Identity object
      if (arguments[1]?.includes('ecd_wp/portfoliomanager/portfolio?')) {
        originalResponse.addEventListener('readystatechange', function () {
          if (originalResponse.readyState === 4) {
            const jsonInfos = JSON.parse(originalResponse.responseText)
            self.userInfos.push(jsonInfos)
          }
        })
        return proxied.apply(this, [].slice.call(arguments))
      }
      // Intercepting response for recent bills blobs.
      if (arguments[1]?.includes('facture/v1.0/pdf?billDate')) {
        originalResponse.addEventListener('readystatechange', function () {
          if (originalResponse.readyState === 4) {
            self.recentPromisesToConvertBlobToBase64 = []
            self.recentXhrUrls = []
            // Pushing in an array the converted to base64 blob and pushing in another array it's href to match the indexes.
            self.recentPromisesToConvertBlobToBase64.push(
              blobToBase64(originalResponse.response)
            )
            self.recentXhrUrls.push(originalResponse.__zone_symbol__xhrURL)

            // In every case, always returning the original response untouched
            return originalResponse
          }
        })
      }
      // Intercepting response for old bills blobs.
      if (arguments[1]?.includes('ecd_wp/facture/historicPDF?')) {
        originalResponse.addEventListener('readystatechange', function () {
          if (originalResponse.readyState === 4) {
            self.oldPromisesToConvertBlobToBase64 = []
            self.oldXhrUrls = []
            self.oldPromisesToConvertBlobToBase64.push(
              blobToBase64(originalResponse.response)
            )
            self.oldXhrUrls.push(originalResponse.__zone_symbol__xhrURL)

            return originalResponse
          }
        })
      }
      return proxied.apply(this, [].slice.call(arguments))
    }

    // Intercepting more infos for Identity object
    if (arguments[1]?.includes('ecd_wp/account/identification')) {
      self.originalResponse.addEventListener('readystatechange', function () {
        if (self.originalResponse.readyState === 4) {
          const jsonInfos = JSON.parse(self.originalResponse.responseText)
          self.userInfos.push(jsonInfos)
        }
      })
      return proxied.apply(this, [].slice.call(arguments))
    }
    // Intercepting billingAddress infos for Identity object
    if (arguments[1]?.includes('ecd_wp/account/billingAddresses')) {
      self.originalResponse.addEventListener('readystatechange', function () {
        if (self.originalResponse.readyState === 4) {
          const jsonInfos = JSON.parse(self.originalResponse.responseText)
          self.userInfos.push(jsonInfos)
        }
      })
      return proxied.apply(this, [].slice.call(arguments))
    }
  }
}

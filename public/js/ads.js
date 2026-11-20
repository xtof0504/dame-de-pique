// Publicités AdMob (uniquement dans l'app Android, rien dans le navigateur).
// Pour passer en production :
//   1. Remplacer BANNER_ID par votre ID de bloc d'annonces (ca-app-pub-XXXX/YYYY)
//   2. Mettre TESTING à false
//   3. Remplacer l'APPLICATION_ID dans android/app/src/main/AndroidManifest.xml
(function () {
  var BANNER_ID = 'ca-app-pub-3940256099942544/9214589741'; // ID de TEST Google (bannière adaptative)
  var TESTING = true;

  var Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  var AdMob = (Cap.Plugins && Cap.Plugins.AdMob) || (Cap.registerPlugin && Cap.registerPlugin('AdMob'));
  if (!AdMob) return;

  // Réserve la place de la bannière en bas de l'écran pour qu'elle ne cache pas le jeu.
  function setBannerHeight(h) {
    document.documentElement.style.setProperty('--ad-height', (h || 0) + 'px');
  }

  async function start() {
    try {
      await AdMob.initialize({ initializeForTesting: TESTING });

      // Consentement RGPD (formulaire Google, affiché seulement si nécessaire, ex. en Europe).
      try {
        var info = await AdMob.requestConsentInfo();
        if (info.isConsentFormAvailable && info.status === 'REQUIRED') {
          info = await AdMob.showConsentForm();
        }
      } catch (e) { console.warn('AdMob consent', e); }

      AdMob.addListener('bannerAdSizeChanged', function (size) { setBannerHeight(size && size.height); });
      AdMob.addListener('bannerAdFailedToLoad', function (err) { console.warn('AdMob banner', err); setBannerHeight(0); });

      await AdMob.showBanner({
        adId: BANNER_ID,
        adSize: 'ADAPTIVE_BANNER',
        position: 'BOTTOM_CENTER',
        margin: 0,
        isTesting: TESTING
      });
    } catch (e) {
      console.warn('AdMob', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

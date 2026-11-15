// Adresse du serveur de jeu.
// - Dans un navigateur, la page est servie par le serveur lui-même : on se connecte
//   à la même adresse (valeur vide).
// - Dans l'app Android (Capacitor), on se connecte au serveur en ligne (Oracle Cloud).
//   Si l'adresse du serveur change, modifier SERVER_URL_APP puis regénérer l'APK.
(function () {
  var SERVER_URL_APP = 'http://88.96.47.146:3000';
  var isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  window.SERVER_URL = isNativeApp ? SERVER_URL_APP : '';
})();

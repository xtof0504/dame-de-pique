// Adresse du serveur de jeu.
// - Dans un navigateur, la page est servie par le serveur lui-même : on se connecte
//   à la même adresse (valeur vide).
// - Dans l'app Android (Capacitor), on se connecte directement au PC sur le Wi-Fi local.
//   Si l'adresse IP du PC change, modifier LAN_SERVER_URL puis regénérer l'APK.
(function () {
  var LAN_SERVER_URL = 'http://192.168.1.228:3000';
  var isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  window.SERVER_URL = isNativeApp ? LAN_SERVER_URL : '';
})();

// Applies the saved theme before first paint (loaded synchronously in <head>).
// Same model as AVN Hub: data-theme = dark|light, data-palette = ember (none) | slate | moss ...
(function () {
  var root = document.documentElement;
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
  function apply() {
    var theme = read('avn-theme') === 'light' ? 'light' : 'dark';
    var palette = read('avn-palette') || 'ember';
    root.setAttribute('data-theme', theme);
    if (palette === 'ember') root.removeAttribute('data-palette'); else root.setAttribute('data-palette', palette);
  }
  window.avnTheme = {
    theme: function () { return root.getAttribute('data-theme') || 'dark'; },
    palette: function () { return root.getAttribute('data-palette') || 'ember'; },
    setTheme: function (value) { write('avn-theme', value); apply(); },
    setPalette: function (value) { write('avn-palette', value); apply(); },
  };
  apply();
})();

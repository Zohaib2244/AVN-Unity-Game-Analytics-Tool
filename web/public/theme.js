// Applies the saved theme before first paint (loaded synchronously in <head>).
// Same model as AVN Hub: data-theme = dark|light, data-palette = nutmeg (none) | slate | moss | hibiscus | white | chiral | dora
(function () {
  var root = document.documentElement;
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ } }
  function apply() {
    var theme = read('avn-theme') === 'light' ? 'light' : 'dark';
    var palette = read('avn-palette');
    if (['slate', 'moss', 'hibiscus', 'white', 'chiral', 'dora'].indexOf(palette) < 0) palette = 'nutmeg';
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-density', read('avn-density') === 'compact' ? 'compact' : 'roomy');
    if (palette === 'nutmeg') root.removeAttribute('data-palette'); else root.setAttribute('data-palette', palette);
  }
  window.avnTheme = {
    theme: function () { return root.getAttribute('data-theme') || 'dark'; },
    palette: function () { return root.getAttribute('data-palette') || 'nutmeg'; },
    setTheme: function (value) { write('avn-theme', value); apply(); },
    setPalette: function (value) { write('avn-palette', value); apply(); },
    density: function () { return root.getAttribute('data-density') || 'roomy'; },
    setDensity: function (value) { write('avn-density', value); apply(); },
  };
  apply();
})();

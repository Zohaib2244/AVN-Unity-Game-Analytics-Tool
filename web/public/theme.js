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
    root.setAttribute('data-density', 'roomy'); // one density: the Roomy/Compact switch was removed
    if (palette === 'nutmeg') root.removeAttribute('data-palette'); else root.setAttribute('data-palette', palette);
    if (document.readyState !== 'loading') paintIcon();
  }
  // The tab icon and the browser's theme colour follow the palette: the same three colours as the mark in the app
  // (page background, accent, text). Painted once the style sheets are in, and again whenever the theme changes.
  function colour(name) {
    var probe = document.createElement('i');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--' + name + ')';
    root.appendChild(probe);
    var value = getComputedStyle(probe).color;
    root.removeChild(probe);
    return value;
  }
  function paintIcon() {
    if (!getComputedStyle(root).getPropertyValue('--accent').trim()) return;
    var bg = colour('bg'), accent = colour('accent'), text = colour('text');
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" shape-rendering="crispEdges"><rect width="10" height="10" fill="' + bg + '"/>'
      + '<path fill="' + accent + '" d="M2 1h5v1H2zM1 2h1v5H1zM7 2h1v5H7zM2 7h5v1H2zM8 1h1v1H8z"/><path fill="' + text + '" d="M3 5h1v2H3zM5 3h1v4H5z"/></svg>';
    var icon = document.querySelector('link[rel="icon"]');
    if (icon) icon.setAttribute('href', 'data:image/svg+xml,' + encodeURIComponent(svg));
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
  }
  document.addEventListener('DOMContentLoaded', paintIcon);
  window.addEventListener('load', paintIcon);

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

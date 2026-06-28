(function () {
  "use strict";

  var state = {
    loaded: false,
    loading: null,
    config: null,
    widgetId: null,
  };

  function loadConfig() {
    if (state.config) return Promise.resolve(state.config);
    return fetch("/api/public-config", { cache: "no-store" })
      .then(function (res) { return res.json(); })
      .then(function (config) {
        state.config = {
          siteKey: config.turnstileSiteKey || "",
          required: Boolean(config.requireTurnstile),
        };
        return state.config;
      })
      .catch(function () {
        state.config = { siteKey: "", required: false };
        return state.config;
      });
  }

  function loadScript() {
    if (window.turnstile) return Promise.resolve();
    if (state.loading) return state.loading;
    state.loading = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = function () { state.loaded = true; resolve(); };
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return state.loading;
  }

  function container() {
    var el = document.getElementById("vs-turnstile-container");
    if (el) return el;
    el = document.createElement("div");
    el.id = "vs-turnstile-container";
    el.style.position = "fixed";
    el.style.right = "24px";
    el.style.bottom = "96px";
    el.style.width = "300px";
    el.style.minHeight = "65px";
    el.style.zIndex = "2147483647";
    document.body.appendChild(el);
    return el;
  }

  async function getToken() {
    var config = await loadConfig();
    if (!config.siteKey) return "";
    await loadScript();
    if (!window.turnstile) return "";

    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) resolve("");
      }, 10000);

      function finish(token) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(token || "");
      }

      try {
        if (state.widgetId == null) {
          state.widgetId = window.turnstile.render(container(), {
            sitekey: config.siteKey,
            execution: "execute",
            appearance: "interaction-only",
            callback: finish,
            "error-callback": function () {},
            "expired-callback": function () { finish(""); },
          });
        } else {
          window.turnstile.reset(state.widgetId);
        }
        window.turnstile.execute(state.widgetId);
      } catch {
        finish("");
      }
    });
  }

  window.VSTurnstile = {
    getToken: getToken,
    getConfig: loadConfig,
  };
})();

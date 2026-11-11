// The page someone lands on from a camera invite (#69).
//
// Everything it needs is after # in the link: the club's address (u) and name
// (n). The browser never sends that part to this server. The link carries no
// code: the app opens with the address filled in and the person types the code
// from the invite. Links made by platform 0.7.4 also carry the code (c); they
// still work, and open the app paired as they did then.
(function () {
  "use strict";

  var params = new URLSearchParams(location.hash.slice(1));
  var apiUrl = params.get("u") || "";
  var code = (params.get("c") || "").trim().toUpperCase();
  var club = (params.get("n") || "").trim();

  function validUrl(value) {
    try {
      var u = new URL(value);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch (e) {
      return false;
    }
  }

  var codeOk = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code);
  var ok = validUrl(apiUrl) && (!code || codeOk);
  var show = function (id, on) {
    var el = document.getElementById(id);
    if (el) el.hidden = !on;
  };

  if (!ok) {
    show("joinBroken", true);
    show("joinInvite", false);
    return;
  }

  document.querySelectorAll("[data-club]").forEach(function (el) {
    el.textContent = club || el.textContent;
  });
  document.querySelectorAll("[data-address]").forEach(function (el) {
    el.textContent = apiUrl;
  });
  if (code) {
    document.querySelectorAll("[data-code]").forEach(function (el) {
      el.textContent = code;
    });
    show("joinCodeBox", true);
  }

  var appLink = "courtside-camera://pair?url=" + encodeURIComponent(apiUrl);
  if (code) appLink += "&code=" + encodeURIComponent(code);
  document.getElementById("joinOpenApp").setAttribute("href", appLink);

  var ua = navigator.userAgent;
  var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var android = /Android/.test(ua);

  if (!ios) {
    show(android ? "joinAndroid" : "joinDesktop", true);
    if (!android && window.courtsideQr) {
      window.courtsideQr(location.href).then(function (svg) {
        document.getElementById("joinQr").innerHTML = svg;
      });
    }
  }

  function copyButton(id, text) {
    var button = document.getElementById(id);
    if (!button) return;
    button.addEventListener("click", function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          button.textContent = button.getAttribute("data-done");
        }, function () {});
      }
    });
  }
  copyButton("joinCopyCode", code);
  copyButton("joinCopyAddress", apiUrl);
})();

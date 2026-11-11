// The page someone lands on from a camera invite (#69).
//
// Everything it needs is after # in the link: the club's address (u), the
// invite code (c) and the club's name (n). The browser never sends that part
// to this server, so the code stays out of its logs. The page does not talk to
// the club's installation; whether the invite still works is for the camera
// app to say when it redeems the code.
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

  var ok = validUrl(apiUrl) && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code);
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
  document.querySelectorAll("[data-code]").forEach(function (el) {
    el.textContent = code;
  });

  var appLink =
    "courtside-camera://pair?url=" + encodeURIComponent(apiUrl) + "&code=" + encodeURIComponent(code);
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

  var copy = document.getElementById("joinCopyCode");
  if (copy) {
    copy.addEventListener("click", function () {
      var done = function () {
        copy.textContent = copy.getAttribute("data-done");
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, function () {});
      }
    });
  }
})();

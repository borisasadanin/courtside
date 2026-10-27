// Courtside landing page: price calculator and installer. Strings come from T,
// keyed by the page's <html lang>, so the Swedish and English pages share this file.

var T = ({
  sv: {
    locale: "sv-SE", perMonth: " €/mån",
    reco: function (m, pm, pct) { return "Ungefär " + m + " matcher i månaden, runt " + pm + " € per match. Ni använder omkring " + pct + " % av planens tokens."; },
    recoPeak: " Sänder ni bara så mycket under delar av säsongen räcker Personal med ett tokenpaket i toppveckorna.",
    recoBig: " Större än så? Prata med oss om en Enterprise-plan.",
    flagClub: "För stora föreningar", flagFits: "Passar er",
    error: function (s) { return "Något gick fel (" + s + ")."; },
    yourCourtside: "Er Courtside", toYourCourtside: "Till er Courtside",
    plan: "Plan: ", tokensLeft: " tokens kvar", unknown: "Okänt",
    status: { running: ["Igång", "ok"], building: ["Bygger", ""], failed: ["Fel vid bygge", "bad"], installing: ["Installeras", ""] },
    renew: "Förnya åtkomst", renewTitle: "Sändningsmotorns åtkomst gäller i 90 dagar. Förnya innan den går ut.",
    renewing: "Förnyar…", renewed: "Förnyad",
    reset: "Glömt admin-koden?", resetTitle: "Ger en ny uppsättningskod. Tittarkoden och alla inspelningar finns kvar.",
    resetConfirm: "Du får en ny uppsättningskod och väljer en ny admin-kod. Tittarkoden och alla inspelningar finns kvar. Sidan är nere någon minut medan den startar om.",
    resetting: "Återställer…", resetDone: "Återställd",
    resetNote: function (c) { return "Ny uppsättningskod: " + c + ". Öppna er sida om en minut och välj en ny admin-kod."; },
    open: "Öppna", remove: "Ta bort", removing: "Tar bort…",
    removeConfirm: function (c) { return "Det här tar bort " + c + " och ALLA inspelningar. Det går inte att ångra.\n\nSkriv " + c + " för att bekräfta."; },
    auth: {
      denied: "Du tackade nej till att ge Courtside åtkomst, så inget har skapats på ditt Open Source Cloud-konto. Courtside behöver åtkomsten för att kunna starta tjänsterna åt er. Ändrar du dig går det bra att försöka igen.",
      failed: "Inloggningen hos Open Source Cloud blev inte klar, kanske för att den tog för lång tid. Försök igen.",
      unavailable: "Vi når inte Open Source Cloud just nu. Försök igen om en stund.",
      signedout: "Du är utloggad från Courtside. Du kan fortfarande vara inloggad på Open Source Cloud i den här webbläsaren, och då släpps du in direkt nästa gång. Delar du datorn med andra, logga ut även på app.osaas.io."
    },
    free: function (d) { return "✓ " + d + " är ledig"; }, checking: "Kontrollerar adressen…",
    taken: function (d) { return d + " är redan tagen. Välj ett annat kortnamn."; },
    shareLabel: "Adress att dela med tittarna", copied: "Kopierad",
    done: "Klart!", needName: "Skriv föreningens namn.",
    badShortName: "Kortnamnet ska vara 3–21 små bokstäver eller siffror och börja med en bokstav."
  },
  en: {
    locale: "en-GB", perMonth: " €/month",
    reco: function (m, pm, pct) { return "About " + m + " matches a month, around " + pm + " € per match. You would use about " + pct + " % of the plan's tokens."; },
    recoPeak: " If you only stream this much part of the season, Personal plus a token pack in the busy weeks is enough.",
    recoBig: " Bigger than that? Talk to us about an Enterprise plan.",
    flagClub: "For large clubs", flagFits: "Fits you",
    error: function (s) { return "Something went wrong (" + s + ")."; },
    yourCourtside: "Your Courtside", toYourCourtside: "Go to your Courtside",
    plan: "Plan: ", tokensLeft: " tokens left", unknown: "Unknown",
    status: { running: ["Running", "ok"], building: ["Building", ""], failed: ["Build failed", "bad"], installing: ["Installing", ""] },
    renew: "Renew access", renewTitle: "The broadcast engine's access lasts 90 days. Renew it before it runs out.",
    renewing: "Renewing…", renewed: "Renewed",
    reset: "Forgot the admin code?", resetTitle: "Gives you a new setup code. The viewer code and all recordings stay.",
    resetConfirm: "You get a new setup code and choose a new admin code. The viewer code and all recordings stay. The site is down for a minute while it restarts.",
    resetting: "Resetting…", resetDone: "Reset",
    resetNote: function (c) { return "New setup code: " + c + ". Open your site in a minute and choose a new admin code."; },
    open: "Open", remove: "Remove", removing: "Removing…",
    removeConfirm: function (c) { return "This removes " + c + " and ALL recordings. It cannot be undone.\n\nType " + c + " to confirm."; },
    auth: {
      denied: "You declined to give Courtside access, so nothing was created in your Open Source Cloud account. Courtside needs that access to start the services for you. If you change your mind, just try again.",
      failed: "Signing in with Open Source Cloud didn't finish, perhaps because it took too long. Please try again.",
      unavailable: "We can't reach Open Source Cloud right now. Please try again in a moment.",
      signedout: "You are signed out of Courtside. You may still be signed in to Open Source Cloud in this browser, in which case you are let straight in next time. If you share this computer, sign out at app.osaas.io too."
    },
    free: function (d) { return "✓ " + d + " is free"; }, checking: "Checking the address…",
    taken: function (d) { return d + " is already taken. Choose another short name."; },
    shareLabel: "Address to share with viewers", copied: "Copied",
    done: "Done!", needName: "Enter your club's name.",
    badShortName: "The short name must be 3–21 lowercase letters or digits and start with a letter."
  }
})[document.documentElement.lang === "en" ? "en" : "sv"];
  (function () {
    // Token model, from OSC list prices (ceiling rates):
    // always on: app (backend + website) 10 + object storage 10 + parameter store
    // (Valkey 10 + config 1) = 31 tokens/day — see docs/cost.md.
    // live: Restreamer 160 tokens/day, metered only while running = 160/24 per hour,
    // and it stays up for an hour after the last broadcast.
    var BASE_PER_DAY = 31;
    var LIVE_PER_HOUR = 160 / 24;
    var GRACE_HOURS = 1;
    var DAYS = 30;
    var WEEKS_PER_MONTH = 52 / 12;
    var PLANS = [
      { id: "PERSONAL", name: "Personal", price: 15, perMonth: 40 * DAYS },
      { id: "PROFESSIONAL", name: "Professional", price: 69, perMonth: 300 * DAYS },
      { id: "BUSINESS", name: "Business", price: 199, perMonth: 1000 * DAYS }
    ];
    var HEADROOM = 0.95;

    var $ = function (id) { return document.getElementById(id); };
    var fmt = function (n) { return Math.round(n).toLocaleString(T.locale); };
    var m = $("matches"), h = $("hours");

    function render() {
      var matches = +m.value, hours = +h.value;
      $("matches-out").textContent = matches;
      $("hours-out").textContent = String(hours).replace(".", ",") + " h";

      var base = BASE_PER_DAY * DAYS;
      var live = matches * WEEKS_PER_MONTH * (hours + GRACE_HOURS) * LIVE_PER_HOUR;
      var total = base + live;
      var plan = PLANS.find(function (p) { return total <= p.perMonth * HEADROOM; }) || PLANS[PLANS.length - 1];
      var scale = Math.max(plan.perMonth, total);

      $("tok-month").textContent = fmt(total);
      $("tok-base").textContent = fmt(base);
      $("tok-live").textContent = fmt(live);
      $("tok-plan").textContent = fmt(plan.perMonth);
      $("bar-base").style.width = (base / scale * 100) + "%";
      $("bar-live").style.width = (live / scale * 100) + "%";

      var matchesPerMonth = matches * WEEKS_PER_MONTH;
      var perMatch = plan.price / matchesPerMonth;
      $("reco-plan").innerHTML = plan.name + " <em>" + plan.price + T.perMonth + "</em>";
      $("reco-text").textContent =
        T.reco(fmt(matchesPerMonth), perMatch.toLocaleString(T.locale, { maximumFractionDigits: perMatch < 10 ? 2 : 0 }),
          Math.round(total / plan.perMonth * 100));
      if (plan.id === "PROFESSIONAL" && total < PLANS[0].perMonth * 1.5)
        $("reco-text").textContent += T.recoPeak;
      if (plan.id === "BUSINESS") $("reco-text").textContent += T.recoBig;

      $("card-personal").classList.toggle("is-reco", plan.id === "PERSONAL");
      $("flag-personal").hidden = plan.id !== "PERSONAL";
      $("card-professional").classList.toggle("featured", plan.id !== "PERSONAL");
      $("flag-professional").textContent = plan.id === "PERSONAL" ? T.flagClub : T.flagFits;

      document.querySelectorAll(".preset").forEach(function (b) {
        b.setAttribute("aria-pressed", String(+b.dataset.m === matches && +b.dataset.h === hours));
      });
    }

    m.addEventListener("input", render);
    h.addEventListener("input", render);
    document.querySelectorAll(".preset").forEach(function (b) {
      b.addEventListener("click", function () { m.value = b.dataset.m; h.value = b.dataset.h; render(); });
    });

    // Same flow as the other OSC product pages: open the OSC pricing page for the chosen plan.
    document.querySelectorAll("[data-plan]").forEach(function (b) {
      b.addEventListener("click", function () {
        var plan = b.dataset.plan;
        var url = "https://app.osaas.io/dashboard/pricing?plan=" + plan +
          "&utm_source=courtside&utm_medium=cta&utm_campaign=landing&utm_content=pricing-" + plan.toLowerCase();
        window.open(url, "subscription", "width=600,height=700,toolbar=no,menubar=no,scrollbars=yes,resizable=yes");
      });
    });

    render();
  })();
  // Installer: sign in with OSC, then create a club's Courtside in its own account.
  (function () {
    var $ = function (id) { return document.getElementById(id); };
    var STEPS = ["check", "storage", "token", "config", "app", "build", "online"];
    var signedIn = false;
    var pollTimer = null;

    function api(method, url, body) {
      return fetch(url, {
        method: method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin"
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status === 401) sessionExpired();
          if (!r.ok) throw new Error(data.error || T.error(r.status));
          return data;
        });
      });
    }

    // The sign-in can run out while the page is open (it lasts a while, and a
    // restart of this page's server ends it). Keep the panel and what was
    // typed, say so, and come back to the same form after signing in again.
    var DRAFT = "courtside-draft";
    function sessionExpired() {
      signedIn = false;
      try {
        sessionStorage.setItem(DRAFT, JSON.stringify({ display: $("f-display").value, club: $("f-club").value }));
      } catch (e) { /* no storage: the form is just empty afterwards */ }
      $("inst-expired").hidden = false;
      $("inst-expired").scrollIntoView({ block: "center" });
    }
    function restoreDraft() {
      try {
        var d = JSON.parse(sessionStorage.getItem(DRAFT) || "null");
        sessionStorage.removeItem(DRAFT);
        if (!d) return;
        $("f-display").value = d.display || "";
        $("f-club").value = d.club || "";
        if (d.club) { clubTouched = true; checkAvailable(); }
      } catch (e) { /* nothing saved */ }
    }

    function showPanel(on) {
      $("installera").hidden = !on;
      document.querySelectorAll("[data-start]").forEach(function (a) {
        if (on) { a.setAttribute("href", "#installera"); a.textContent = a.id === "header-cta" ? T.yourCourtside : T.toYourCourtside; }
      });
    }

    // Suggests a short name from the club's name: "Älta IF Basket" -> "altaifbasket".
    function slug(text) {
      return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 21);
    }
    var clubTouched = false;
    // The short name becomes the club's address, shared by every OSC account,
    // so it is checked as it is typed rather than after a failed install.
    var availTimer, availFor = "", availOk;
    function checkAvailable() {
      var club = $("f-club").value.trim(), out = $("f-club-avail");
      clearTimeout(availTimer);
      availOk = undefined;
      out.textContent = ""; out.className = "avail";
      if (!/^[a-z][a-z0-9]{2,20}$/.test(club)) return;
      out.textContent = T.checking;
      availTimer = setTimeout(function () {
        availFor = club;
        fetch("/api/available/" + encodeURIComponent(club), { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (a) {
          if (availFor !== $("f-club").value.trim()) return;
          availOk = a.available;
          if (a.available === true) { out.textContent = T.free(a.domain); out.className = "avail ok"; }
          else if (a.available === false) { out.textContent = /redan en Courtside|already have/.test(a.reason || "") ? a.reason : T.taken(a.domain); out.className = "avail bad"; }
          else out.textContent = "";
        }).catch(function () { out.textContent = ""; });
      }, 400);
    }
    $("f-display").addEventListener("input", function () { if (!clubTouched) $("f-club").value = slug(this.value); checkAvailable(); });
    $("f-club").addEventListener("input", function () { clubTouched = true; this.value = this.value.toLowerCase(); checkAvailable(); });

    function el(tag, attrs, text) {
      var e = document.createElement(tag);
      for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
      if (text) e.textContent = text;
      return e;
    }

    function loadAccount() {
      api("GET", "/api/account").then(function (a) {
        $("acc-plan").textContent = a.plan ? T.plan + a.plan.charAt(0) + a.plan.slice(1).toLowerCase() : "";
        $("acc-tokens").textContent = a.tokensLeft != null ? Math.round(a.tokensLeft).toLocaleString(T.locale) + T.tokensLeft : "";
      }).catch(function () {});
    }

    var STATUS = T.status;

    function loadList() {
      return api("GET", "/api/installations").then(function (d) {
        var list = $("inst-list");
        list.textContent = "";
        $("inst-empty").hidden = d.installations.length > 0;
        d.installations.forEach(function (i) {
          var li = el("li", { "class": "inst-item" });
          var row = el("div", { "class": "row" });
          row.appendChild(el("span", { "class": "name" }, i.club));
          var st = STATUS[i.status] || [i.status || T.unknown, ""];
          row.appendChild(el("span", { "class": "status " + st[1] }, st[0]));
          li.appendChild(row);
          if (i.url) {
            li.appendChild(el("span", { "class": "url-label" }, T.shareLabel));
            var a = el("a", { "class": "url", href: i.url, target: "_blank", rel: "noopener" }, i.url.replace(/^https:\/\//, ""));
            li.appendChild(a);
          }
          if (i.status !== "installing") {
            var actions = el("div", { "class": "inst-actions" });
            var renew = el("button", { type: "button", "class": "btn btn-secondary btn-sm" }, T.renew);
            renew.title = T.renewTitle;
            renew.addEventListener("click", function () {
              renew.disabled = true; renew.textContent = T.renewing;
              api("POST", "/api/installations/" + i.club + "/renew").then(function () {
                renew.textContent = T.renewed;
              }).catch(function (e) { alert(e.message); renew.disabled = false; renew.textContent = T.renew; });
            });
            var reset = el("button", { type: "button", "class": "btn btn-secondary btn-sm" }, T.reset);
            reset.title = T.resetTitle;
            reset.addEventListener("click", function () {
              if (!confirm(T.resetConfirm)) return;
              reset.disabled = true; reset.textContent = T.resetting;
              api("POST", "/api/installations/" + i.club + "/reset-admin").then(function (d) {
                reset.textContent = T.resetDone;
                var note = el("p", { "class": "inst-reset" }, T.resetNote(d.setupCode));
                if (i.url) {
                  note.appendChild(document.createTextNode(" "));
                  note.appendChild(el("a", { href: i.url + "/#setup=" + encodeURIComponent(d.setupCode), target: "_blank", rel: "noopener" }, T.open));
                }
                li.appendChild(note);
              }).catch(function (e) { alert(e.message); reset.disabled = false; reset.textContent = T.reset; });
            });
            var del = el("button", { type: "button", "class": "btn btn-secondary btn-sm" }, T.remove);
            del.addEventListener("click", function () {
              var answer = prompt(T.removeConfirm(i.club));
              if (answer === null) return;
              del.disabled = true; del.textContent = T.removing;
              api("DELETE", "/api/installations/" + i.club, { confirm: answer.trim() }).then(loadList)
                .catch(function (e) { alert(e.message); del.disabled = false; del.textContent = T.remove; });
            });
            actions.appendChild(renew);
            actions.appendChild(reset);
            actions.appendChild(del);
            li.appendChild(actions);
          }
          list.appendChild(li);
        });
      }).catch(function (e) { $("inst-empty").hidden = false; $("inst-empty").textContent = e.message; });
    }

    function showProgress(job) {
      $("create-view").hidden = true;
      $("progress-view").hidden = false;
      $("progress-club").textContent = job.club;
      var at = STEPS.indexOf(job.step);
      document.querySelectorAll("#steps li").forEach(function (li) {
        var i = STEPS.indexOf(li.dataset.step);
        li.className = i < at || job.state === "done" ? "done" : i === at ? (job.state === "failed" ? "fail" : "now") : "";
      });
      $("progress-error").textContent = job.state === "failed" ? job.error + " Det som hann skapas har tagits bort." : "";
      $("progress-back").hidden = job.state === "running";
      if (job.state === "done") {
        $("progress-h").textContent = T.done;
        $("done-box").hidden = false;
        $("done-code").textContent = job.setupCode;
        $("done-url").textContent = job.siteUrl.replace(/^https:\/\//, "");
        $("done-url").href = job.siteUrl;
        $("done-open").href = job.siteUrl + "/#setup=" + encodeURIComponent(job.setupCode);
        $("done-copy").onclick = function () {
          var b = this;
          navigator.clipboard.writeText(job.siteUrl).then(function () { b.textContent = T.copied; });
        };
      }
      if (job.state !== "running") { clearInterval(pollTimer); pollTimer = null; loadList(); loadAccount(); }
    }

    function poll(club) {
      clearInterval(pollTimer);
      pollTimer = setInterval(function () {
        api("GET", "/api/installations/" + club + "/job").then(showProgress).catch(function () {});
      }, 3000);
    }

    $("progress-back").addEventListener("click", function () {
      $("progress-view").hidden = true;
      $("done-box").hidden = true;
      $("progress-h").innerHTML = 'Skapar <span id="progress-club"></span>';
      $("create-view").hidden = false;
    });

    $("create-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var displayName = $("f-display").value.trim();
      var club = $("f-club").value.trim();
      $("create-error").textContent = "";
      if (!displayName) { $("create-error").textContent = T.needName; $("f-display").focus(); return; }
      if (!/^[a-z][a-z0-9]{2,20}$/.test(club)) {
        $("f-club").setAttribute("aria-invalid", "true");
        $("create-error").textContent = T.badShortName;
        $("f-club").focus();
        return;
      }
      if (availOk === false) { $("create-error").textContent = $("f-club-avail").textContent; $("f-club").focus(); return; }
      $("f-club").removeAttribute("aria-invalid");
      $("create-btn").disabled = true;
      api("POST", "/api/installations", { club: club, displayName: displayName }).then(function (job) {
        showProgress(job);
        poll(club);
        loadList();
      }).catch(function (e) {
        if (signedIn) $("create-error").textContent = e.message;
      }).then(function () { $("create-btn").disabled = false; });
    });

    $("signout").addEventListener("click", function () {
      fetch("/auth/signout", { method: "POST", credentials: "same-origin" }).then(function () { location.href = location.pathname + "?auth=signedout#kom-igang"; });
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden || !signedIn) return;
      fetch("/auth/status", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (st) {
        if (!st.authenticated) sessionExpired();
      }).catch(function () {});
    });

    var authReason = new URLSearchParams(location.search).get("auth");
    if (authReason && T.auth[authReason]) {
      $("auth-notice").textContent = T.auth[authReason];
      $("auth-notice").hidden = false;
      history.replaceState(null, "", location.pathname + location.hash);
    }

    fetch("/auth/status", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (s) {
      signedIn = !!s.authenticated;
      showPanel(signedIn);
      if (!signedIn) return;
      loadAccount();
      loadList();
      restoreDraft();
      var params = new URLSearchParams(location.search);
      if (params.get("start") === "1") {
        history.replaceState(null, "", location.pathname);
        $("installera").scrollIntoView();
        $("f-display").focus();
      }
    }).catch(function () {});
  })();

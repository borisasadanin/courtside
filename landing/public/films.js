// Plays the product films: one scene at a time, in a loop, with a caption per
// scene. A film plays only while it is on screen, and holds still for anyone
// who has asked for reduced motion.
(function () {
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var labels = document.documentElement.lang === "en"
    ? { pause: "Pause film", play: "Play film" }
    : { pause: "Pausa filmen", play: "Spela filmen" };

  // Numbers that tick up while a scene plays, e.g. the viewer count.
  function countUp(scene) {
    scene.querySelectorAll("[data-count]").forEach(function (el) {
      var to = +el.getAttribute("data-count"), word = el.textContent.replace(/^[\d\s]+/, "");
      var t0 = performance.now(), ms = reduced ? 0 : 2400;
      (function step(now) {
        var k = ms ? Math.min(1, (now - t0) / ms) : 1;
        el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))) + " " + word;
        if (k < 1) requestAnimationFrame(step);
      })(t0);
    });
  }

  document.querySelectorAll(".film").forEach(function (film) {
    var scenes = Array.prototype.slice.call(film.querySelectorAll(".scene"));
    var caption = film.querySelector(".film-caption span");
    var bar = film.querySelector(".film-bar");
    var toggle = film.querySelector(".film-toggle");
    var index = -1, timer = null, playing = false, userPaused = false, visible = false;

    function show(i) {
      scenes.forEach(function (sc) { sc.classList.remove("on"); });
      index = i;
      var scene = scenes[index];
      // Restart the scene's CSS animations from the beginning.
      void scene.offsetWidth;
      scene.classList.add("on");
      countUp(scene);
      caption.textContent = scene.getAttribute("data-caption") || "";
      var dur = +scene.getAttribute("data-dur") || 3500;
      bar.style.transition = "none"; bar.style.width = (index / scenes.length * 100) + "%";
      void bar.offsetWidth;
      bar.style.transition = "width " + dur + "ms linear";
      bar.style.width = ((index + 1) / scenes.length * 100) + "%";
      if (playing) timer = setTimeout(function () { show((index + 1) % scenes.length); }, dur);
    }

    function play() {
      if (playing || reduced) return;
      playing = true;
      show(index < 0 ? 0 : (index + 1) % scenes.length);
      toggle.textContent = "❚❚"; toggle.setAttribute("aria-label", labels.pause);
    }

    function pause() {
      playing = false; clearTimeout(timer);
      var w = getComputedStyle(bar).width; bar.style.transition = "none"; bar.style.width = w;
      toggle.textContent = "▶"; toggle.setAttribute("aria-label", labels.play);
    }

    toggle.addEventListener("click", function () {
      if (playing) { userPaused = true; pause(); } else { userPaused = false; play(); }
    });

    if (reduced) {
      // A still: the scene that tells the most.
      var key = scenes.length - 1;
      scenes[key].classList.add("on");
      caption.textContent = scenes[key].getAttribute("data-caption") || "";
      countUp(scenes[key]);
      toggle.hidden = true;
      return;
    }

    // Until it scrolls into view: the first scene, still.
    scenes[0].classList.add("on");
    caption.textContent = scenes[0].getAttribute("data-caption") || "";
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible && !userPaused) play(); else if (!visible) pause();
    }, { threshold: 0.35 }).observe(film);
  });
})();

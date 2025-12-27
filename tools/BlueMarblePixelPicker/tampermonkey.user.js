// ==UserScript==
// @name         BlueMarble Coordinate Sender
// @namespace    local.blue.marble
// @version      0.1
// @description  读取鼠标所在像素坐标并发送到本地程序
// @match        *://wplace.live/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  const endpoint = 'http://localhost:8787/coords';
  let lastSent = 0;

  function bmPickerPageInit() {
    if (window.__bmPickerPage) {
      return;
    }
    var mapNameOverrides = ['map', 'wplaceMap', 'maplibreMap', '__map', 'mapboxglMap'];
    var lastClientX = 0;
    var lastClientY = 0;
    var hasMapApi = function (obj) {
      return obj && typeof obj.getCanvas === 'function' && typeof obj.unproject === 'function';
    };
    var tryWrapMaplibre = function (ml) {
      try {
        if (!ml || !ml.Map) return;
        if (ml.Map.__bmPickerWrapped) return;
        var Orig = ml.Map;
        var WrappedMap = function () {
          var map = new (Function.prototype.bind.apply(Orig, [null].concat([].slice.call(arguments))))();
          try { window.__bmPickerMap = map; } catch (_) {}
          return map;
        };
        WrappedMap.__bmPickerWrapped = true;
        WrappedMap.prototype = Orig.prototype;
        WrappedMap.prototype.constructor = WrappedMap;
        for (var k in Orig) {
          try {
            if (Object.prototype.hasOwnProperty.call(Orig, k)) {
              WrappedMap[k] = Orig[k];
            }
          } catch (_) {}
        }
        ml.Map = WrappedMap;
      } catch (_) {}
    };
    var installMaplibreHook = function () {
      try {
        var desc = Object.getOwnPropertyDescriptor(window, 'maplibregl');
        if (!desc || desc.configurable) {
          var current = window.maplibregl;
          Object.defineProperty(window, 'maplibregl', {
            configurable: true,
            get: function () { return current; },
            set: function (v) { current = v; tryWrapMaplibre(v); }
          });
          if (current) { tryWrapMaplibre(current); }
        } else {
          tryWrapMaplibre(window.maplibregl);
        }
      } catch (_) {}
      try {
        var desc2 = Object.getOwnPropertyDescriptor(window, 'mapboxgl');
        if (!desc2 || desc2.configurable) {
          var current2 = window.mapboxgl;
          Object.defineProperty(window, 'mapboxgl', {
            configurable: true,
            get: function () { return current2; },
            set: function (v) { current2 = v; tryWrapMaplibre(v); }
          });
          if (current2) { tryWrapMaplibre(current2); }
        } else {
          tryWrapMaplibre(window.mapboxgl);
        }
      } catch (_) {}
    };
    var findMapInMaplibre = function (root) {
      var ml = root;
      if (!ml || (typeof ml !== 'object' && typeof ml !== 'function')) return null;
      var queue = [ml];
      var visited = new WeakSet();
      var visitedCount = 0;
      while (queue.length && visitedCount < 500) {
        var obj = queue.shift();
        visitedCount++;
        try {
          if (hasMapApi(obj)) return obj;
        } catch (_) {}
        if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) continue;
        if (visited.has(obj)) continue;
        visited.add(obj);
        var keys = [];
        try { keys = Object.getOwnPropertyNames(obj); } catch (_) { keys = []; }
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var v;
          try { v = obj[k]; } catch (_) { continue; }
          if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
          queue.push(v);
        }
      }
      return null;
    };
    var scanElementForMap = function (el) {
      if (!el) return null;
      var props = Object.getOwnPropertyNames(el);
      for (var i = 0; i < props.length; i++) {
        var p = props[i];
        try {
          var v = el[p];
          if (hasMapApi(v)) return v;
        } catch (_) {}
      }
      return null;
    };
    var getMapInstance = function () {
      if (hasMapApi(window.__bmPickerMap)) return window.__bmPickerMap;
      if (typeof window.__bmPickerMapName === 'string') {
        var byName = window[window.__bmPickerMapName];
        if (hasMapApi(byName)) return byName;
      }
      if (typeof window.__bmPickerMapPath === 'string') {
        try {
          var parts = window.__bmPickerMapPath.split('.');
          var acc = window;
          for (var i = 0; i < parts.length; i++) {
            acc = acc ? acc[parts[i]] : null;
          }
          if (hasMapApi(acc)) return acc;
        } catch (_) {}
      }
      for (var i = 0; i < mapNameOverrides.length; i++) {
        var name = mapNameOverrides[i];
        var c = window[name];
        if (hasMapApi(c)) return c;
      }
      if (window.maplibregl) {
        var fromLib = findMapInMaplibre(window.maplibregl);
        if (fromLib) return fromLib;
      }
      if (window.mapboxgl) {
        var fromBox = findMapInMaplibre(window.mapboxgl);
        if (fromBox) return fromBox;
      }
      var container = document.querySelector('#map') || document.querySelector('[data-map]') || document.body;
      var canvas =
        document.querySelector('#map canvas.maplibregl-canvas') ||
        document.querySelector('#map canvas') ||
        document.querySelector('canvas.maplibregl-canvas') ||
        document.querySelector('canvas.mapboxgl-canvas') ||
        document.querySelector('canvas');
      var fromCanvas = scanElementForMap(canvas);
      if (fromCanvas) return fromCanvas;
      var fromContainer = scanElementForMap(container);
      if (fromContainer) return fromContainer;
      var parent = (canvas && canvas.parentElement) || (container && container.parentElement);
      var fromParent = scanElementForMap(parent);
      if (fromParent) return fromParent;
      return null;
    };
    var getTilePixel = function () {
      var map = getMapInstance();
      var canvas = map && typeof map.getCanvas === 'function'
        ? map.getCanvas()
        : (document.querySelector('#map canvas.maplibregl-canvas') ||
           document.querySelector('#map canvas') ||
           document.querySelector('canvas.maplibregl-canvas') ||
           document.querySelector('canvas.mapboxgl-canvas') ||
           document.querySelector('canvas'));
      if (!canvas) return { ok: false, reason: 'canvas_not_found' };
      var rect = canvas.getBoundingClientRect();
      var x = lastClientX - rect.left;
      var y = lastClientY - rect.top;
      if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) {
        return { ok: false, reason: 'mouse_outside_canvas' };
      }
      if (!map || typeof map.unproject !== 'function') {
        return { ok: false, reason: 'map_not_found' };
      }
      var lngLat = map.unproject([x, y]);
      var mercator = window.maplibregl && window.maplibregl.MercatorCoordinate;
      if (!mercator || typeof mercator.fromLngLat !== 'function') {
        return { ok: false, reason: 'mercator_unavailable' };
      }
      var mc = mercator.fromLngLat(lngLat);
      var worldSize = map && map.transform ? map.transform.worldSize : null;
      var tileSize = map && map.transform ? (map.transform.tileSize || 512) : 512;
      if (!worldSize || !tileSize) {
        return { ok: false, reason: 'transform_unavailable' };
      }
      var worldX = mc.x * worldSize;
      var worldY = mc.y * worldSize;
      var tileX = Math.floor(worldX / tileSize);
      var tileY = Math.floor(worldY / tileSize);
      var pxX = Math.floor(worldX - tileX * tileSize);
      var pxY = Math.floor(worldY - tileY * tileSize);
      return {
        ok: true,
        tileX: tileX,
        tileY: tileY,
        pxX: pxX,
        pyY: pxY,
        tileSize: tileSize,
        cellX: tileX * tileSize + pxX,
        cellY: tileY * tileSize + pxY
      };
    };
    window.__bmPickerScan = function () {
      var canvas =
        document.querySelector('#map canvas.maplibregl-canvas') ||
        document.querySelector('#map canvas') ||
        document.querySelector('canvas.maplibregl-canvas') ||
        document.querySelector('canvas.mapboxgl-canvas') ||
        document.querySelector('canvas');
      var container = document.querySelector('#map') || document.body;
      return {
        readyState: document.readyState,
        canvasFound: !!canvas,
        canvasTag: canvas ? canvas.tagName : null,
        canvasClass: canvas ? canvas.className : null,
        containerFound: !!container,
        containerTag: container ? container.tagName : null,
        canvasOwnProps: canvas ? Object.getOwnPropertyNames(canvas).slice(0, 50) : [],
        containerOwnProps: container ? Object.getOwnPropertyNames(container).slice(0, 50) : []
      };
    };
    var isSkippable = function (v) {
      if (!v) return true;
      if (v === window || v === document) return true;
      if (v.nodeType) return true;
      var ctor = v.constructor && v.constructor.name;
      if (ctor === 'HTMLDocument' || ctor === 'Window') return true;
      return false;
    };
    window.__bmPickerFindMap = function (maxDepth, maxNodes) {
      maxDepth = maxDepth == null ? 3 : maxDepth;
      maxNodes = maxNodes == null ? 3000 : maxNodes;
      var hits = [];
      var queue = [];
      var visited = new WeakSet();
      var push = function (obj, path, depth) {
        if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
        if (visited.has(obj)) return;
        if (isSkippable(obj)) return;
        visited.add(obj);
        queue.push({ obj: obj, path: path, depth: depth });
      };
      push(window, 'window', 0);
      var visitedCount = 0;
      while (queue.length && visitedCount < maxNodes) {
        var item = queue.shift();
        var obj = item.obj;
        var path = item.path;
        var depth = item.depth;
        visitedCount++;
        try {
          if (hasMapApi(obj)) {
            hits.push(path);
            if (hits.length >= 10) break;
          }
        } catch (_) {}
        if (depth >= maxDepth) continue;
        var keys = [];
        try { keys = Object.getOwnPropertyNames(obj); } catch (_) { keys = []; }
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (k === 'window' || k === 'document') continue;
          var v;
          try { v = obj[k]; } catch (_) { continue; }
          if (typeof v !== 'object' && typeof v !== 'function') continue;
          if (isSkippable(v)) continue;
          push(v, path + '.' + k, depth + 1);
        }
      }
      return hits;
    };
    window.addEventListener('mousemove', function (e) {
      lastClientX = e.clientX;
      lastClientY = e.clientY;
    }, { passive: true });
    window.__bmPickerPage = { getTilePixel: getTilePixel };
    installMaplibreHook();
    var tries = 0;
    var poll = window.setInterval(function () {
      tries++;
      if (window.__bmPickerMap && hasMapApi(window.__bmPickerMap)) {
        window.clearInterval(poll);
        return;
      }
      installMaplibreHook();
      var found = getMapInstance();
      if (hasMapApi(found)) {
        window.__bmPickerMap = found;
        window.clearInterval(poll);
        return;
      }
      if (tries > 60) {
        window.clearInterval(poll);
      }
    }, 500);
  }

  function injectPageBridge() {
    if (unsafeWindow.__bmPickerPage && typeof unsafeWindow.__bmPickerPage.getTilePixel === 'function') {
      return;
    }
    const script = document.createElement('script');
    script.textContent = '(' + bmPickerPageInit.toString() + ')();';
    document.documentElement.appendChild(script);
    script.remove();
  }

  function getTilePixel() {
    if (!unsafeWindow.__bmPickerPage || typeof unsafeWindow.__bmPickerPage.getTilePixel !== 'function') {
      return { ok: false, reason: 'page_bridge_not_ready' };
    }
    try {
      return unsafeWindow.__bmPickerPage.getTilePixel();
    } catch (_) {
      return { ok: false, reason: 'page_bridge_failed' };
    }
  }

  function sendLoop() {
    injectPageBridge();
    const payload = getTilePixel();
    const now = Date.now();
    if (now - lastSent < 80) {
      requestAnimationFrame(sendLoop);
      return;
    }
    lastSent = now;
    GM_xmlhttpRequest({
      method: 'POST',
      url: endpoint,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload),
      onerror: () => {
        // 本地程序可能未启动，忽略错误
      }
    });
    requestAnimationFrame(sendLoop);
  }

  sendLoop();
})();

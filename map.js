/* 2026 FIFA World Cup — Team Base Camps + Venues */

/* Teams making their World Cup debut in 2026 */
const DEBUT_TEAMS = new Set(['Cape Verde', 'CuraCao', 'Jordan', 'Uzbekistan']);

/* One accent colour per group (dark enough for white text) */
const GROUP_COLORS = {
  A: '#DC2626', B: '#EA580C', C: '#CA8A04', D: '#16A34A',
  E: '#0D9488', F: '#2563EB', G: '#7C3AED', H: '#DB2777',
  I: '#E11D48', J: '#0891B2', K: '#65A30D', L: '#475569',
};

/* ── Map init ──────────────────────────────────────────────────────────────── */
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  bounds: [[-138, 16], [-52, 58]],
  fitBoundsOptions: {
    padding: { top: 70, bottom: 50, left: 50, right: 260 },
  },
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

/* ── State ─────────────────────────────────────────────────────────────────── */
let currentPopup     = null;
let currentPopupTeam = null;   // null when a venue popup is open
const allMarkers      = [];    // { marker, team, el }
const allVenueMarkers = [];    // { marker, venue, el }
let teamsData    = [];         // from teams.json
let matchesData  = [];         // from matches.csv
let _dragCleanup        = null;   // cleanup fn for current popup drag
let currentLayer        = 'all'; // 'all' | 'teams' | 'stadiums'
let _suppressNextClick  = false; // set by makeDraggable to swallow post-drag click
let _allowRestore       = false; // true only when X button or filter intentionally closes popup

/* ── CSV parser (handles quoted fields) ────────────────────────────────────── */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const headers = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCsvLine(line);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = values[idx] ?? ''; });
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inQuotes) {
      inQuotes = true;
    } else if (ch === '"' && inQuotes) {
      if (line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = false; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/* ── Lines layer helpers ───────────────────────────────────────────────────── */
function clearLines() {
  const src = map.getSource('lines-source');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
}

/**
 * Draw dashed lines from one origin to multiple destinations.
 * @param {[number,number]}   from  [lng, lat]
 * @param {[number,number][]} tos   array of [lng, lat]
 */
function drawLines(from, tos) {
  const src = map.getSource('lines-source');
  if (!src) return;
  const features = tos.map(to => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [from, to] },
  }));
  src.setData({ type: 'FeatureCollection', features });
}

/* ── Load data & build markers ─────────────────────────────────────────────── */
map.on('load', async () => {

  /* ── Add lines GeoJSON source + layer (must be before markers) ── */
  map.addSource('lines-source', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'lines-layer',
    type: 'line',
    source: 'lines-source',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#666',
      'line-opacity': 0.6,
      'line-width': 2,
      'line-dasharray': [2, 2],
    },
  });

  /* ── Load teams.json ── */
  try {
    const res = await fetch('data/teams.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    teamsData = await res.json();
  } catch (err) {
    console.error('Failed to load teams.json:', err);
    return;
  }

  /* ── Load matches.csv ── */
  try {
    const res = await fetch('data/matches.csv');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    matchesData = parseCsv(await res.text());
  } catch (err) {
    console.error('Failed to load matches.csv — lines/venue popups disabled:', err);
  }

  /* ── Team markers ── */
  const pixelOffsets = calcOverlapOffsets(teamsData);
  teamsData.forEach(team => {
    if (team.lng == null || team.lat == null) return;
    const el     = createTeamMarkerEl(team);
    const offset = pixelOffsets[team.team] || [0, 0];
    const marker = new maplibregl.Marker({ element: el, anchor: 'center', offset })
      .setLngLat([team.lng, team.lat])
      .addTo(map);
    el.addEventListener('click', e => { e.stopPropagation(); openTeamPopup(team); });
    allMarkers.push({ marker, team, el });
  });

  /* ── Venue markers (deduplicated by venue name) ── */
  const venueMap = new Map();
  matchesData.forEach(m => {
    if (!venueMap.has(m.venue)) {
      venueMap.set(m.venue, {
        venue:          m.venue,
        venue_official: m.venue_official,
        city:           m.city,
        lat:  parseFloat(m.venue_lat),
        lng:  parseFloat(m.venue_lng),
      });
    }
  });

  venueMap.forEach(venue => {
    const el     = createVenueMarkerEl(venue);
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([venue.lng, venue.lat])
      .addTo(map);
    el.addEventListener('click', e => { e.stopPropagation(); openVenuePopup(venue); });
    allVenueMarkers.push({ marker, venue, el });
  });
});

/* Popup closes only via the X button (closeOnClick: false is already set).
   Switching markers also closes the current popup in openTeamPopup /
   openVenuePopup before opening a new one.                                 */

/* ── Overlap detection: spread co-located markers with pixel offsets ─────── */
function calcOverlapOffsets(teams) {
  const SPREAD = 20;
  const buckets = {};
  teams.forEach(t => {
    if (t.lng == null) return;
    const key = `${t.lng.toFixed(3)},${t.lat.toFixed(3)}`;
    (buckets[key] = buckets[key] || []).push(t.team);
  });
  const offsets = {};
  Object.values(buckets).forEach(names => {
    if (names.length === 1) { offsets[names[0]] = [0, 0]; return; }
    names.forEach((name, i) => {
      if (names.length === 2) {
        offsets[name] = i === 0 ? [-SPREAD / 2, 0] : [SPREAD / 2, 0];
      } else {
        const angle = (i / names.length) * Math.PI * 2 - Math.PI / 2;
        offsets[name] = [Math.cos(angle) * SPREAD, Math.sin(angle) * SPREAD];
      }
    });
  });
  return offsets;
}

/* ── Marker elements ─────────────────────────────────────────────────────── */
function createTeamMarkerEl(team) {
  const div = document.createElement('div');
  div.className    = 'team-marker';
  div.dataset.group = team.group;
  div.setAttribute('title', team.team);
  const img = document.createElement('img');
  img.src      = `https://hatscripts.github.io/circle-flags/flags/${team.country_code.toLowerCase()}.svg`;
  img.alt      = team.team;
  img.draggable = false;
  div.appendChild(img);
  return div;
}

function createVenueMarkerEl(venue) {
  const div = document.createElement('div');
  div.className = 'venue-marker';
  div.setAttribute('title', venue.venue);
  div.textContent = '🏟️';
  return div;
}

/* ── Team popup ──────────────────────────────────────────────────────────── */
function openTeamPopup(team) {
  if (currentPopup) currentPopup.remove();
  clearLines();

  currentPopupTeam = team;
  currentPopup = new maplibregl.Popup({
    offset: [0, -20],
    className: 'team-popup',
    maxWidth: '580px',
    closeButton: true,
    closeOnClick: false,
  })
    .setLngLat([team.lng, team.lat])
    .setHTML(buildTeamPopupHTML(team))
    .addTo(map);

  currentPopup.on('close', () => {
    if (_dragCleanup) { _dragCleanup(); _dragCleanup = null; }
    currentPopup = null;
    currentPopupTeam = null;
    clearLines();
    /* Only restore marker brightness when the user intentionally closed */
    if (_allowRestore) { _allowRestore = false; restoreAllFilters(); }
  });

  _dragCleanup = makeDraggable(currentPopup.getElement());
  attachXRestore(currentPopup);

  /* Compute match venues and draw lines */
  const teamMatchVenues = new Set();
  if (matchesData.length > 0) {
    const seen = new Set();
    const tos  = [];
    matchesData
      .filter(m => m.team_a === team.team || m.team_b === team.team)
      .forEach(m => {
        teamMatchVenues.add(m.venue);
        if (!seen.has(m.venue)) {
          seen.add(m.venue);
          tos.push([parseFloat(m.venue_lng), parseFloat(m.venue_lat)]);
        }
      });
    if (tos.length) drawLines([team.lng, team.lat], tos);
  }

  /* Fade all → brighten selected team + its match venues */
  allMarkers.forEach(({ el, team: t }) => {
    el.classList.toggle('marker-faded', t.team !== team.team);
  });
  allVenueMarkers.forEach(({ el, venue }) => {
    el.classList.toggle('marker-faded', !teamMatchVenues.has(venue.venue));
  });
}

/* ── Venue popup ─────────────────────────────────────────────────────────── */
function openVenuePopup(venue) {
  if (currentPopup) currentPopup.remove();
  clearLines();

  currentPopupTeam = null; // venue popup has no group
  currentPopup = new maplibregl.Popup({
    offset: [0, -20],
    className: 'team-popup venue-popup-wrap',
    maxWidth: '360px',
    closeButton: true,
    closeOnClick: false,
  })
    .setLngLat([venue.lng, venue.lat])
    .setHTML(buildVenuePopupHTML(venue))
    .addTo(map);

  currentPopup.on('close', () => {
    if (_dragCleanup) { _dragCleanup(); _dragCleanup = null; }
    currentPopup = null;
    clearLines();
    if (_allowRestore) { _allowRestore = false; restoreAllFilters(); }
  });

  _dragCleanup = makeDraggable(currentPopup.getElement());
  attachXRestore(currentPopup);

  /* Compute teams at this venue and draw lines */
  const venueTeamNames = new Set();
  if (matchesData.length > 0) {
    matchesData
      .filter(m => m.venue === venue.venue)
      .forEach(m => { venueTeamNames.add(m.team_a); venueTeamNames.add(m.team_b); });

    const tos = [];
    venueTeamNames.forEach(name => {
      const t = teamsData.find(td => td.team === name);
      if (t && t.lng != null) tos.push([t.lng, t.lat]);
    });
    if (tos.length) drawLines([venue.lng, venue.lat], tos);
  }

  /* Fade all → brighten selected venue + its teams */
  allVenueMarkers.forEach(({ el, venue: v }) => {
    el.classList.toggle('marker-faded', v.venue !== venue.venue);
  });
  allMarkers.forEach(({ el, team }) => {
    el.classList.toggle('marker-faded', !venueTeamNames.has(team.team));
  });
}

/* ── Popup HTML builders ─────────────────────────────────────────────────── */
function buildTeamPopupHTML(team) {
  const flagUrl    = `https://hatscripts.github.io/circle-flags/flags/${team.country_code.toLowerCase()}.svg`;
  const groupColor = GROUP_COLORS[team.group] || '#6B7280';
  const isDebut    = DEBUT_TEAMS.has(team.team);
  const hotelName  = (team.hotel_name && team.hotel_name !== 'TBD') ? team.hotel_name : 'TBD';
  const hotelAddr  = hotelName !== 'TBD' ? team.hotel_address : '';

  /* ── Matches section ── */
  const teamMatches = matchesData
    .filter(m => m.team_a === team.team || m.team_b === team.team)
    .sort((a, b) => a.date.localeCompare(b.date));

  const matchCardsHTML = teamMatches.map(m => {
    const isA    = m.team_a === team.team;
    const oppName = isA ? m.team_b      : m.team_a;
    const oppCode = (isA ? m.team_b_code : m.team_a_code).toLowerCase();
    const oppFlag = `https://hatscripts.github.io/circle-flags/flags/${oppCode}.svg`;

    /* Distance: base camp → match venue */
    let distHTML = '';
    if (team.lat != null && team.lng != null) {
      const km = Math.round(haversineKm(
        team.lat, team.lng,
        parseFloat(m.venue_lat), parseFloat(m.venue_lng),
      ));
      const mi = Math.round(km * 0.621371);
      distHTML = `<div class="match-card-dist">📏 ${km.toLocaleString()} km / ${mi.toLocaleString()} mi</div>`;
    }

    return /* html */`
      <div class="match-card">
        <div class="match-card-top">
          <span class="match-card-date">${fmtDate(m.date)}&nbsp;·</span>
          <span class="match-card-opp">vs&nbsp;<img class="match-flag" src="${oppFlag}" alt="${oppName}" />&nbsp;<span class="match-team-name">${oppName}</span></span>
        </div>
        <div class="match-card-venue">📍 ${m.venue} · ${m.city}</div>
        ${distHTML}
      </div>`;
  }).join('');

  const hasMatches = matchCardsHTML.length > 0;

  return /* html */`
    <div class="popup-inner">

      <div class="popup-header">
        <img class="popup-flag" src="${flagUrl}" alt="${team.team}" />
        <div class="popup-meta">
          <div class="popup-team-name">${team.team}</div>
          <div class="popup-pills">
            <span class="group-pill" style="background:${groupColor}">Group&nbsp;${team.group}</span>
          </div>
        </div>
        ${hasMatches ? '<div class="popup-matches-label">Matches</div>' : ''}
      </div>

      <div class="popup-divider"></div>

      <div class="popup-body">
        <div class="popup-left">
          <div class="popup-row">
            <span class="popup-icon">📍</span>
            <div class="popup-info">
              <div class="info-name">${team.training_site}</div>
              <div class="info-addr">${team.training_address}</div>
            </div>
          </div>
          <div class="popup-row">
            <span class="popup-icon">🏨</span>
            <div class="popup-info">
              <div class="info-name">${hotelName}</div>
              ${hotelAddr ? `<div class="info-addr">${hotelAddr}</div>` : ''}
            </div>
          </div>
        </div>

        ${hasMatches ? /* html */`
        <div class="popup-col-divider"></div>
        <div class="popup-right">
          <div class="match-cards-list">${matchCardsHTML}</div>
        </div>` : ''}
      </div>

      ${isDebut ? '<div class="debut-tag">🌟 World Cup Debut</div>' : ''}

    </div>
  `;
}

function buildVenuePopupHTML(venue) {
  const venueMatches = matchesData
    .filter(m => m.venue === venue.venue)
    .sort((a, b) => a.date.localeCompare(b.date));

  const rows = venueMatches.map(m => {
    const dateStr = fmtDate(m.date);
    const fA = `https://hatscripts.github.io/circle-flags/flags/${m.team_a_code.toLowerCase()}.svg`;
    const fB = `https://hatscripts.github.io/circle-flags/flags/${m.team_b_code.toLowerCase()}.svg`;
    return /* html */`
      <div class="venue-match-row">
        <div class="venue-match-date">📅 ${dateStr} &nbsp;·&nbsp; Group ${m.group}</div>
        <div class="venue-match-teams">
          <img class="match-flag" src="${fA}" alt="${m.team_a}" />
          <span class="match-team-name">${m.team_a}</span>
          <span class="match-vs">vs</span>
          <img class="match-flag" src="${fB}" alt="${m.team_b}" />
          <span class="match-team-name">${m.team_b}</span>
        </div>
      </div>`;
  }).join('');

  return /* html */`
    <div class="popup-inner venue-popup-inner">

      <div class="venue-popup-header">
        <div class="venue-name">${venue.venue}</div>
        <div class="venue-city">${venue.city}</div>
      </div>

      <div class="popup-divider"></div>

      <div class="venue-matches-title">Matches Here</div>
      <div class="venue-matches-list">${rows}</div>

    </div>
  `;
}

/* "2026-06-11" → "Jun 11" */
function fmtDate(dateStr) {
  const m  = dateStr.match(/\d{4}-(\d{2})-(\d{2})/);
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${mo[parseInt(m[1], 10) - 1]} ${parseInt(m[2], 10)}`;
}

/* Haversine great-circle distance (km) between two lat/lng points */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/* ── Draggable popup ─────────────────────────────────────────────────────────
   Lets the user drag any popup away from the lines beneath it.
   Uses MutationObserver to prevent MapLibre from overriding position each frame.
   Returns a cleanup function to call when the popup closes.               */
function makeDraggable(popupEl) {
  const handle = popupEl.querySelector('.popup-header, .venue-popup-header');
  if (!handle) return () => {};

  let dragging   = false;
  let isDetached = false; // true after first drag; stays true to keep fixed pos
  let startMX = 0, startMY = 0;
  let startL  = 0, startT  = 0;
  let curL    = 0, curT    = 0;

  /* Apply position: fixed so MapLibre's absolute positioning is bypassed */
  function pin(l, t) {
    popupEl.style.position  = 'fixed';
    popupEl.style.left      = l + 'px';
    popupEl.style.top       = t + 'px';
    popupEl.style.transform = 'none';
  }

  /* Observer blocks MapLibre from overriding our pinned position */
  const obs = new MutationObserver(() => {
    if (!dragging && !isDetached) return;
    obs.disconnect();
    pin(curL, curT);
    obs.observe(popupEl, { attributes: true, attributeFilter: ['style'] });
  });

  /* ── Core drag logic (shared by mouse & touch) ── */
  function startDrag(clientX, clientY) {
    const rect = popupEl.getBoundingClientRect();
    startL  = rect.left;  startT  = rect.top;
    curL    = startL;     curT    = startT;
    startMX = clientX;    startMY = clientY;

    dragging = isDetached = true;
    handle.style.cursor = 'grabbing';
    popupEl.classList.add('popup-dragging');

    obs.disconnect();
    pin(curL, curT);
    obs.observe(popupEl, { attributes: true, attributeFilter: ['style'] });
  }

  function moveDrag(clientX, clientY) {
    if (!dragging) return;
    curL = startL + (clientX - startMX);
    curT = startT + (clientY - startMY);
    obs.disconnect();
    pin(curL, curT);
    obs.observe(popupEl, { attributes: true, attributeFilter: ['style'] });
  }

  function endDrag() {
    dragging = false;
    handle.style.cursor = 'grab';
    popupEl.classList.remove('popup-dragging');
    // obs keeps watching so popup stays at dropped position
  }

  /* ── Mouse events ── */
  function onMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    startDrag(e.clientX, e.clientY);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }
  function onMouseMove(e) { moveDrag(e.clientX, e.clientY); }
  function onMouseUp(e) {
    const moved = Math.abs(e.clientX - startMX) > 3 || Math.abs(e.clientY - startMY) > 3;
    endDrag();
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    /* Tell the document click handler to ignore the phantom click that
       the browser fires immediately after a drag's mouseup.             */
    if (moved) _suppressNextClick = true;
  }

  /* ── Touch events ── */
  function onTouchStart(e) {
    e.preventDefault(); e.stopPropagation();
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
  }
  function onTouchMove(e) { e.preventDefault(); moveDrag(e.touches[0].clientX, e.touches[0].clientY); }
  function onTouchEnd() { endDrag(); }

  handle.style.cursor = 'grab';
  handle.addEventListener('mousedown', onMouseDown);
  handle.addEventListener('touchstart', onTouchStart, { passive: false });
  handle.addEventListener('touchmove',  onTouchMove,  { passive: false });
  handle.addEventListener('touchend',   onTouchEnd);

  /* Cleanup: disconnect observer, remove listeners */
  return () => {
    obs.disconnect();
    dragging = isDetached = false;
    handle.removeEventListener('mousedown',   onMouseDown);
    handle.removeEventListener('touchstart',  onTouchStart);
    handle.removeEventListener('touchmove',   onTouchMove);
    handle.removeEventListener('touchend',    onTouchEnd);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup',   onMouseUp);
  };
}

/* ── Restore all markers to layer + group filter baseline ────────────────── */
function restoreAllFilters() {
  const showTeams    = currentLayer === 'all' || currentLayer === 'teams';
  const showStadiums = currentLayer === 'all' || currentLayer === 'stadiums';

  const activeGroupBtn = document.querySelector('.filter-btn[data-group].active');
  const currentGroup   = activeGroupBtn ? activeGroupBtn.dataset.group : 'all';

  allMarkers.forEach(({ el, team }) => {
    const inGroup = currentGroup === 'all' || team.group === currentGroup;
    const on      = showTeams && inGroup;
    el.classList.toggle('marker-faded', !on);
  });

  allVenueMarkers.forEach(({ el }) => {
    el.classList.toggle('marker-faded', !showStadiums);
  });
}

/* Attach a one-time capture-phase listener to the popup X button so that
   clicking it sets _allowRestore = true BEFORE MapLibre's own close handler
   fires.  That way the close event knows the user intentionally closed.    */
function attachXRestore(popup) {
  const el  = popup.getElement();
  const btn = el && el.querySelector(
    '.maplibregl-popup-close-button, .mapboxgl-popup-close-button');
  if (btn) {
    btn.addEventListener('click', () => { _allowRestore = true; },
      { capture: true, once: true });
  }
}

/* ── Close popup when user clicks on the map background ─────────────────── */
/* map.on('click') only fires on the canvas — marker clicks are blocked by   */
/* stopPropagation, map-drag doesn't fire click, popup-drag starts on the    */
/* popup DOM so the canvas never sees it.                                    */
map.on('click', () => {
  if (currentPopup) {
    _allowRestore = true;
    currentPopup.remove();
  }
});

/* ── Group filter ────────────────────────────────────────────────────────── */
const groupBtns = document.querySelectorAll('.filter-btn[data-group]');
groupBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    groupBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const group = btn.dataset.group;

    if (currentPopup) {
      if (currentPopupTeam && group !== 'all' && currentPopupTeam.group !== group) {
        _allowRestore = true;
        currentPopup.remove();
      }
    } else {
      restoreAllFilters();
    }
  });
});

/* ── Layer filter (Teams / Stadiums / All) ───────────────────────────────── */
const layerBtns = document.querySelectorAll('.filter-btn[data-layer]');
layerBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    layerBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentLayer = btn.dataset.layer;

    if (currentPopup) {
      _allowRestore = true;
      currentPopup.remove();
    } else {
      restoreAllFilters();
    }
  });
});

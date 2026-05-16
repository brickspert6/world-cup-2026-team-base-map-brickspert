/* 2026 FIFA World Cup — Team Base Camps */

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
  /* Initial view: all three host nations */
  bounds: [[-138, 16], [-52, 58]],
  fitBoundsOptions: {
    padding: { top: 70, bottom: 50, left: 50, right: 260 },
  },
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

/* ── State ─────────────────────────────────────────────────────────────────── */
let currentPopup = null;
let currentPopupTeam = null;
const allMarkers = []; // { marker, team, el }

/* ── Load teams & build markers ─────────────────────────────────────────────── */
map.on('load', async () => {
  let teams;
  try {
    const res = await fetch('data/teams.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    teams = await res.json();
  } catch (err) {
    console.error('Failed to load teams.json:', err);
    return;
  }

  const pixelOffsets = calcOverlapOffsets(teams);

  teams.forEach(team => {
    if (team.lng == null || team.lat == null) return;

    const el = createMarkerEl(team);
    const offset = pixelOffsets[team.team] || [0, 0];

    const marker = new maplibregl.Marker({ element: el, anchor: 'center', offset })
      .setLngLat([team.lng, team.lat])
      .addTo(map);

    el.addEventListener('click', e => {
      e.stopPropagation(); // prevent map.click from immediately closing
      openPopup(team);
    });

    allMarkers.push({ marker, team, el });
  });
});

/* Close popup when clicking the map background.
   Use document-level listener so we can exclude clicks on markers,
   popups, and the filter panel — MapLibre 4 can re-fire map.on('click')
   even after stopPropagation, so we avoid it entirely. */
document.addEventListener('click', e => {
  if (!currentPopup) return;
  if (e.target.closest('.team-marker') ||
      e.target.closest('.maplibregl-popup') ||
      e.target.closest('.filter-panel')) return;
  currentPopup.remove();
});

/* ── Overlap detection: spread co-located markers with pixel offsets ─────────── */
function calcOverlapOffsets(teams) {
  const SPREAD = 20; // px between stacked markers
  // bucket key rounded to 3 decimal places (~100 m precision)
  const buckets = {};
  teams.forEach(t => {
    if (t.lng == null) return;
    const key = `${t.lng.toFixed(3)},${t.lat.toFixed(3)}`;
    (buckets[key] = buckets[key] || []).push(t.team);
  });

  const offsets = {};
  Object.values(buckets).forEach(names => {
    if (names.length === 1) { offsets[names[0]] = [0, 0]; return; }
    // Spread evenly in a circle; for 2 teams just use left / right
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

/* ── Marker element ─────────────────────────────────────────────────────────── */
function createMarkerEl(team) {
  const div = document.createElement('div');
  div.className = 'team-marker';
  div.dataset.group = team.group;
  div.setAttribute('title', team.team);

  const img = document.createElement('img');
  img.src = `https://hatscripts.github.io/circle-flags/flags/${team.country_code.toLowerCase()}.svg`;
  img.alt = team.team;
  img.draggable = false;

  div.appendChild(img);
  return div;
}

/* ── Popup ──────────────────────────────────────────────────────────────────── */
function openPopup(team) {
  if (currentPopup) currentPopup.remove();

  currentPopupTeam = team;
  currentPopup = new maplibregl.Popup({
    offset: [0, -20],
    className: 'team-popup',
    maxWidth: '340px',
    closeButton: true,
    closeOnClick: false,
  })
    .setLngLat([team.lng, team.lat])
    .setHTML(buildPopupHTML(team))
    .addTo(map);

  currentPopup.on('close', () => {
    currentPopup = null;
    currentPopupTeam = null;
  });
}

function buildPopupHTML(team) {
  const flagUrl    = `https://hatscripts.github.io/circle-flags/flags/${team.country_code.toLowerCase()}.svg`;
  const groupColor = GROUP_COLORS[team.group] || '#6B7280';
  const isDebut    = DEBUT_TEAMS.has(team.team);

  const hotelName = (team.hotel_name && team.hotel_name !== 'TBD') ? team.hotel_name : 'TBD';
  const hotelAddr = hotelName !== 'TBD' ? team.hotel_address : '';

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
      </div>

      <div class="popup-divider"></div>

      <div class="popup-section">
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

      ${isDebut ? '<div class="debut-tag">🌟 World Cup Debut</div>' : ''}

    </div>
  `;
}

/* ── Group filter ───────────────────────────────────────────────────────────── */
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    /* Update active state */
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const group = btn.dataset.group;

    /* Fade out non-matching markers */
    allMarkers.forEach(({ el, team }) => {
      const match = group === 'all' || team.group === group;
      el.style.opacity       = match ? '1'    : '0.15';
      el.style.pointerEvents = match ? 'auto' : 'none';
    });

    /* Close popup if its team is now filtered out */
    if (currentPopup && group !== 'all' && currentPopupTeam?.group !== group) {
      currentPopup.remove();
    }
  });
});

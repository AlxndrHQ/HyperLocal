// Netlify Function: /.netlify/functions/get-events
// Proxies Eventbrite, Posh, Luma — supports ZIP, city, or lat/lng queries
// Deploy: netlify/functions/get-events.js in your repo root

const EVENTBRITE_TOKEN = process.env.EVENTBRITE_TOKEN || '';

// Known metro centers
const METRO_COORDS = {
  '10001': { lat: 40.7128, lng: -74.0060, name: 'New York' },
  '20001': { lat: 38.9072, lng: -77.0369, name: 'Washington DC' },
  '20715': { lat: 38.9534, lng: -76.7341, name: 'Bowie' },
  '20716': { lat: 38.9357, lng: -76.7141, name: 'Bowie' },
  '20720': { lat: 38.9784, lng: -76.7741, name: 'Bowie/Mitchellville' },
  '20721': { lat: 38.9612, lng: -76.7541, name: 'Mitchellville' },
  '20745': { lat: 38.8076, lng: -76.9975, name: 'National Harbor' },
  '20601': { lat: 38.6318, lng: -76.9797, name: 'Waldorf' },
  '23510': { lat: 36.8508, lng: -76.2859, name: 'Norfolk' },
  '60601': { lat: 41.8781, lng: -87.6298, name: 'Chicago' },
  '90210': { lat: 34.0522, lng: -118.2437, name: 'Los Angeles' },
  '33101': { lat: 25.7617, lng: -80.1918, name: 'Miami' },
  '30301': { lat: 33.7490, lng: -84.3880, name: 'Atlanta' },
};

// City name → ZIP
const CITY_ZIP = {
  'bowie': '20715', 'national harbor': '20745', 'waldorf': '20601',
  'washington': '20001', 'dc': '20001', 'new york': '10001', 'nyc': '10001',
  'chicago': '60601', 'miami': '33101', 'los angeles': '90210', 'atlanta': '30301',
};

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const p = event.queryStringParameters || {};

  // Resolve center coordinates
  let lat, lng, metroName, zip;

  if (p.lat && p.lng) {
    // Coordinate-based query
    lat = parseFloat(p.lat); lng = parseFloat(p.lng);
    metroName = p.name || 'Area';
    zip = p.zip || '10001';
  } else {
    zip = p.zip || '10001';
    const metro = METRO_COORDS[zip] || METRO_COORDS['10001'];
    lat = metro.lat; lng = metro.lng; metroName = metro.name;
  }

  const vertical = p.vertical || 'all';
  const allEvents = [];
  const errors = [];

  // ── 1. Eventbrite ──
  if (EVENTBRITE_TOKEN) {
    try {
      const url = `https://www.eventbriteapi.com/v3/events/search/?location.latitude=${lat}&location.longitude=${lng}&location.within=20mi&sort_by=best&expand=venue,organizer&token=${EVENTBRITE_TOKEN}&page_size=25`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        for (const [i, ev] of (data.events || []).entries()) {
          const vLat = ev.venue?.latitude ? parseFloat(ev.venue.latitude) : null;
          const vLng = ev.venue?.longitude ? parseFloat(ev.venue.longitude) : null;
          allEvents.push({
            id: 5000 + i,
            name: ev.name?.text || 'Event',
            venue: ev.venue?.name || 'Venue TBD',
            addr: ev.venue?.address?.address_1 || ev.venue?.address?.localized_address_display || '',
            hood: ev.venue?.address?.city || metroName,
            time: ev.start?.local ? new Date(ev.start.local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'TBA',
            price: ev.is_free ? 'Free' : '$' + (ev.ticket_availability?.minimum_ticket_price?.major_value || '?'),
            avail: 50, trending: false, featured: false,
            tags: [(ev.category?.name || 'EVENT').toUpperCase()].filter(Boolean),
            genre: ev.category?.name || 'Live',
            vertical: mapVertical(ev.category?.name),
            source: 'eventbrite',
            ticketUrl: ev.url,
            image_url: ev.logo?.url || ev.logo?.original?.url || null,
            organizer: ev.organizer?.name || null,
            lat: vLat, lng: vLng,
          });
        }
      }
    } catch (e) { errors.push('eventbrite: ' + e.message); }
  }

  // ── 2. Posh ──
  try {
    const poshRes = await fetch(
      `https://posh.vip/api/explore/events?latitude=${lat}&longitude=${lng}&radius=25&limit=15`,
      { headers: { Accept: 'application/json', 'User-Agent': 'HyperLocal/1.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (poshRes.ok) {
      const text = await poshRes.text();
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        const poshData = JSON.parse(text);
        const events = poshData.events || poshData.data || (Array.isArray(poshData) ? poshData : []);
        events.forEach((ev, i) => {
          const vLat = ev.venue?.lat || ev.latitude || null;
          const vLng = ev.venue?.lng || ev.longitude || null;
          allEvents.push({
            id: 6000 + i,
            name: ev.name || ev.title || 'Posh Event',
            venue: ev.venue?.name || ev.venueName || 'Venue TBD',
            addr: ev.venue?.address || '',
            hood: ev.city || metroName,
            time: ev.startTime ? new Date(ev.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'TBA',
            price: ev.minPrice ? '$' + ev.minPrice : 'Free',
            avail: 60, trending: false, featured: false,
            tags: ['POSH'], genre: 'Social', vertical: 'afterdark', source: 'posh',
            ticketUrl: ev.slug ? `https://posh.vip/e/${ev.slug}` : '',
            image_url: ev.coverImageUrl || ev.flyer || null,
            organizer: ev.organizerName || null,
            poshSlug: ev.slug || null,
            lat: vLat ? parseFloat(vLat) : null,
            lng: vLng ? parseFloat(vLng) : null,
          });
        });
      }
    }
  } catch (e) { errors.push('posh: ' + e.message); }

  // ── 3. Luma ──
  try {
    const lumaRes = await fetch(
      `https://api.lu.ma/public/v1/calendar/list-events?pagination_limit=15&geo_latitude=${lat}&geo_longitude=${lng}&geo_radius_km=40`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }
    );
    if (lumaRes.ok) {
      const lumaData = await lumaRes.json();
      (lumaData.entries || []).forEach((item, i) => {
        const ev = item.event || item;
        const vLat = item.geo_address_info?.latitude || null;
        const vLng = item.geo_address_info?.longitude || null;
        allEvents.push({
          id: 7000 + i,
          name: ev.name || 'Luma Event',
          venue: item.geo_address_info?.address || 'Online',
          addr: item.geo_address_info?.full_address || '',
          hood: metroName,
          time: ev.start_at ? new Date(ev.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'TBA',
          price: ev.ticket_info?.is_free ? 'Free' : '$' + (ev.ticket_info?.min_ticket_price || '?'),
          avail: 70, trending: false, featured: false,
          tags: ['LUMA'], genre: 'Networking', vertical: 'professional', source: 'luma',
          ticketUrl: `https://lu.ma/${ev.url || ev.id || ''}`,
          image_url: ev.cover_url || null,
          organizer: ev.hosts?.[0]?.name || null,
          lat: vLat ? parseFloat(vLat) : null,
          lng: vLng ? parseFloat(vLng) : null,
        });
      });
    }
  } catch (e) { errors.push('luma: ' + e.message); }

  // Filter by vertical
  const filtered = vertical === 'all' ? allEvents : allEvents.filter(ev => ev.vertical === vertical);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      events: filtered,
      total: filtered.length,
      zip, lat, lng, metro: metroName,
      errors: errors.length ? errors : undefined,
      timestamp: new Date().toISOString(),
    }),
  };
};

function mapVertical(category) {
  if (!category) return 'terminal';
  const c = category.toLowerCase();
  if (c.includes('food') || c.includes('culinary') || c.includes('drink')) return 'themenu';
  if (c.includes('music') || c.includes('nightlife') || c.includes('concert')) return 'afterdark';
  if (c.includes('business') || c.includes('network') || c.includes('tech')) return 'professional';
  if (c.includes('religion') || c.includes('spiritual')) return 'worship';
  if (c.includes('art') || c.includes('film') || c.includes('comedy')) return 'theladder';
  return 'terminal';
}

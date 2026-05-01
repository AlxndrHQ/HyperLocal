// Netlify Function: /.netlify/functions/get-events
// Proxies Posh + Luma + Eventbrite to avoid CORS
// Deploy: place in /netlify/functions/get-events.js in your repo root

const EVENTBRITE_TOKEN = process.env.EVENTBRITE_TOKEN || process.env.HL_EB_TOKEN || '';
const POSH_BASE = 'https://posh.vip';
const LUMA_BASE = 'https://api.lu.ma';

// ZIP → metro center coordinates for geo searching
const METRO_COORDS = {
  '10001': { lat: 40.7128, lng: -74.006,  name: 'New York' },
  '20001': { lat: 38.9072, lng: -77.0369, name: 'Washington DC' },
  '20715': { lat: 38.9534, lng: -76.7341, name: 'Bowie' },
  '20601': { lat: 38.6318, lng: -76.9797, name: 'Waldorf' },
  '23510': { lat: 36.8508, lng: -76.2859, name: 'Norfolk' },
  '60601': { lat: 41.8781, lng: -87.6298, name: 'Chicago' },
  '90210': { lat: 34.0522, lng: -118.2437, name: 'Los Angeles' },
  '33101': { lat: 25.7617, lng: -80.1918, name: 'Miami' },
};

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const zip = params.zip || '10001';
  const vertical = params.vertical || 'all';
  const metro = METRO_COORDS[zip] || METRO_COORDS['10001'];

  const allEvents = [];
  const errors = [];

  // ── 1. Eventbrite ──
  if (EVENTBRITE_TOKEN) {
    try {
      const ebUrl = `https://www.eventbriteapi.com/v3/events/search/?location.address=${encodeURIComponent(metro.name)}&location.within=25mi&expand=venue,organizer&sort_by=best&token=${EVENTBRITE_TOKEN}&page_size=20`;
      const ebRes = await fetch(ebUrl, { headers: { 'Accept': 'application/json' } });
      if (ebRes.ok) {
        const ebData = await ebRes.json();
        const ebEvents = (ebData.events || []).map((ev, i) => ({
          id: 5000 + i,
          name: ev.name?.text || 'Event',
          venue: ev.venue?.name || 'Venue TBD',
          addr: ev.venue?.address?.address_1 || '',
          hood: ev.venue?.address?.city || metro.name,
          time: ev.start?.local ? new Date(ev.start.local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'TBA',
          price: ev.is_free ? 'Free' : '$' + (ev.ticket_availability?.minimum_ticket_price?.major_value || '?'),
          avail: 50, trending: false, featured: false,
          tags: [ev.category?.name || 'EVENT'].filter(Boolean),
          genre: ev.category?.name || 'Live',
          vertical: mapVertical(ev.category?.name),
          source: 'eventbrite',
          ticketUrl: ev.url,
          image_url: ev.logo?.url || ev.logo?.original?.url || null,
          organizer: ev.organizer?.name || null,
          lat: ev.venue?.latitude ? parseFloat(ev.venue.latitude) : null,
          lng: ev.venue?.longitude ? parseFloat(ev.venue.longitude) : null,
        }));
        allEvents.push(...ebEvents);
      }
    } catch (e) {
      errors.push('eventbrite: ' + e.message);
    }
  }

  // ── 2. Posh ──
  try {
    const poshRes = await fetch(`${POSH_BASE}/api/explore/events?city=${encodeURIComponent(metro.name)}&limit=15`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'HyperLocal/1.0' }
    });
    if (poshRes.ok) {
      const text = await poshRes.text();
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        const poshData = JSON.parse(text);
        const poshEvents = (poshData.events || poshData.data || []).map((ev, i) => ({
          id: 6000 + i,
          name: ev.name || ev.title || 'Posh Event',
          venue: ev.venue?.name || ev.venueName || 'Venue TBD',
          addr: ev.venue?.address || '',
          hood: ev.city || metro.name,
          time: ev.startTime ? new Date(ev.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'TBA',
          price: ev.minPrice ? '$' + ev.minPrice : 'Free',
          avail: 60, trending: false, featured: false,
          tags: ['POSH'],
          genre: 'Social', vertical: 'afterdark', source: 'posh',
          ticketUrl: ev.slug ? `${POSH_BASE}/e/${ev.slug}` : '',
          image_url: ev.coverImageUrl || ev.flyer || null,
          organizer: ev.organizerName || null,
          poshSlug: ev.slug || null,
        }));
        allEvents.push(...poshEvents);
      }
    }
  } catch (e) {
    errors.push('posh: ' + e.message);
  }

  // ── 3. Luma ──
  try {
    const lumaRes = await fetch(`${LUMA_BASE}/public/v1/calendar/list-events?pagination_limit=15&geo_latitude=${metro.lat}&geo_longitude=${metro.lng}&geo_radius_km=40`, {
      headers: { 'Accept': 'application/json' }
    });
    if (lumaRes.ok) {
      const lumaData = await lumaRes.json();
      const lumaEvents = (lumaData.entries || []).map((item, i) => {
        const ev = item.event || item;
        return {
          id: 7000 + i,
          name: ev.name || 'Luma Event',
          venue: item.geo_address_info?.address || 'Online',
          addr: item.geo_address_info?.full_address || '',
          hood: metro.name,
          time: ev.start_at ? new Date(ev.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'TBA',
          price: ev.ticket_info?.is_free ? 'Free' : '$' + (ev.ticket_info?.min_ticket_price || '?'),
          avail: 70, trending: false, featured: false,
          tags: ['LUMA'],
          genre: 'Networking', vertical: 'professional', source: 'luma',
          ticketUrl: `https://lu.ma/${ev.url || ev.id || ''}`,
          image_url: ev.cover_url || null,
          organizer: ev.hosts?.[0]?.name || null,
        };
      });
      allEvents.push(...lumaEvents);
    }
  } catch (e) {
    errors.push('luma: ' + e.message);
  }

  // Filter by vertical if specified
  const filtered = vertical === 'all' ? allEvents : allEvents.filter(ev => ev.vertical === vertical);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      events: filtered,
      total: filtered.length,
      zip,
      metro: metro.name,
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
  if (c.includes('religion') || c.includes('spiritual') || c.includes('community')) return 'worship';
  if (c.includes('art') || c.includes('film') || c.includes('comedy')) return 'theladder';
  return 'terminal';
}

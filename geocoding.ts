// City reverse geocoding with built-in high-accuracy bounding boxes for transport routes & hubs + OpenStreetMap fallback

interface KnownCity {
  name: string;
  country: string;
  lat: number;
  lng: number;
  radiusKm: number;
}

const KNOWN_TRANSPORT_CITIES: KnownCity[] = [
  { name: 'Sukkur', country: 'Pakistan', lat: 27.7052, lng: 68.8574, radiusKm: 30 },
  { name: 'Karachi', country: 'Pakistan', lat: 24.8607, lng: 67.0011, radiusKm: 45 },
  { name: 'Lahore', country: 'Pakistan', lat: 31.5204, lng: 74.3587, radiusKm: 40 },
  { name: 'Multan', country: 'Pakistan', lat: 30.1575, lng: 71.5249, radiusKm: 35 },
  { name: 'Faisalabad', country: 'Pakistan', lat: 31.4504, lng: 73.1350, radiusKm: 35 },
  { name: 'Rawalpindi', country: 'Pakistan', lat: 33.5651, lng: 73.0169, radiusKm: 25 },
  { name: 'Islamabad', country: 'Pakistan', lat: 33.6844, lng: 73.0479, radiusKm: 30 },
  { name: 'Peshawar', country: 'Pakistan', lat: 34.0151, lng: 71.5249, radiusKm: 30 },
  { name: 'Quetta', country: 'Pakistan', lat: 30.1798, lng: 66.9750, radiusKm: 30 },
  { name: 'Hyderabad', country: 'Pakistan', lat: 25.3960, lng: 68.3578, radiusKm: 25 },
  { name: 'Gujranwala', country: 'Pakistan', lat: 32.1877, lng: 74.1945, radiusKm: 25 },
  { name: 'Bahawalpur', country: 'Pakistan', lat: 29.3544, lng: 71.6911, radiusKm: 25 },
  { name: 'Sargodha', country: 'Pakistan', lat: 32.0836, lng: 72.6711, radiusKm: 25 },
  { name: 'Sialkot', country: 'Pakistan', lat: 32.4945, lng: 74.5229, radiusKm: 25 },
  { name: 'Rahim Yar Khan', country: 'Pakistan', lat: 28.4202, lng: 70.2952, radiusKm: 25 },
  { name: 'Gwadar', country: 'Pakistan', lat: 25.1264, lng: 62.3225, radiusKm: 30 },
  { name: 'Hub', country: 'Pakistan', lat: 25.0298, lng: 66.8856, radiusKm: 20 },
  { name: 'Larkana', country: 'Pakistan', lat: 27.5590, lng: 68.2120, radiusKm: 25 },
  { name: 'Moro', country: 'Pakistan', lat: 26.6622, lng: 68.0000, radiusKm: 20 },
  { name: 'Sadiqabad', country: 'Pakistan', lat: 28.3090, lng: 70.1306, radiusKm: 20 },
  { name: 'Nowshera', country: 'Pakistan', lat: 34.0153, lng: 71.9747, radiusKm: 20 },
  { name: 'Dera Ghazi Khan', country: 'Pakistan', lat: 30.0489, lng: 70.6455, radiusKm: 25 },
];

function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export async function reverseGeocodeCoordinates(lat: number, lng: number): Promise<{ city: string; details: string }> {
  // Check known transport cities first for instant sub-millisecond lookup
  let closestCity: KnownCity | null = null;
  let minDistance = Infinity;

  for (const city of KNOWN_TRANSPORT_CITIES) {
    const dist = calculateDistanceKm(lat, lng, city.lat, city.lng);
    if (dist < minDistance) {
      minDistance = dist;
      closestCity = city;
    }
  }

  if (closestCity && minDistance <= closestCity.radiusKm) {
    return {
      city: closestCity.name,
      details: `${closestCity.name}, ${closestCity.country} (approx. ${Math.round(minDistance)}km from hub)`,
    };
  }

  // Try OpenStreetMap Nominatim with timeout
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=12&addressdetails=1`,
      {
        headers: {
          'User-Agent': 'TransportAttendanceApp/1.0',
        },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      const addr = data.address || {};
      const cityName =
        addr.city ||
        addr.town ||
        addr.village ||
        addr.county ||
        addr.state_district ||
        addr.state ||
        (closestCity ? closestCity.name : 'Field Location');

      const country = addr.country || 'Pakistan';
      return {
        city: cityName,
        details: data.display_name || `${cityName}, ${country}`,
      };
    }
  } catch (err) {
    // Network or timeout failure, fall back to nearest known hub or coordinate label
  }

  if (closestCity && minDistance < 150) {
    return {
      city: `${closestCity.name} Region`,
      details: `Near ${closestCity.name}, ${closestCity.country} (${Math.round(minDistance)}km)`,
    };
  }

  return {
    city: `GPS [${lat.toFixed(3)}, ${lng.toFixed(3)}]`,
    details: `Coordinates: ${lat.toFixed(4)} N, ${lng.toFixed(4)} E`,
  };
}

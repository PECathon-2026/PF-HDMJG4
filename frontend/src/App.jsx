
import { useState } from "react";
import "./App.css";

const events = [
  { type: "Meteor Shower", name: "Leonids", date: "November 17–18", icon: "☄️", detail: "A famous annual meteor shower" },
  { type: "Moon Phase", name: "Full Moon", date: "November 24", icon: "🌕", detail: "The Moon's illuminated face is fully visible" },
  { type: "Meteor Shower", name: "Geminids", date: "December 13–14", icon: "🌠", detail: "A major annual meteor shower" },
];

const navItems = ["Overview", "Watchtower", "Celestial Scroll", "Spirit Lens"];

function App() {
  const [active, setActive] = useState("Overview");
  const [city, setCity] = useState("Jaipur");
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(false);
  const [weatherError, setWeatherError] = useState("");
  const [filter, setFilter] = useState("All");
  const [image, setImage] = useState(null);
  const [enhanced, setEnhanced] = useState(null);
  const [notice, setNotice] = useState("");

  async function fetchWeather() {
    if (!city.trim()) return;
    setLoading(true);
    setWeatherError("");
    setNotice("");
    try {
      const geoResponse = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
      );
      if (!geoResponse.ok) throw new Error("Location search failed.");
      const geo = await geoResponse.json();
      if (!geo.results?.length) throw new Error("Location not found. Try another city.");

      const place = geo.results[0];
      const weatherResponse = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,cloud_cover,visibility,wind_speed_10m&daily=sunrise,sunset&timezone=auto&forecast_days=1`
      );
      if (!weatherResponse.ok) throw new Error("Weather service is unavailable.");
      const data = await weatherResponse.json();
      setWeather({
        place: `${place.name}${place.admin1 ? ", " + place.admin1 : ""}`,
        temperature: data.current.temperature_2m,
        humidity: data.current.relative_humidity_2m,
        clouds: data.current.cloud_cover,
        visibility: data.current.visibility,
        wind: data.current.wind_speed_10m,
        sunrise: data.daily.sunrise?.[0],
        sunset: data.daily.sunset?.[0],
      });
      setNotice("Weather data refreshed successfully.");
    } catch (error) {
      setWeatherError(error.message || "Unable to load weather.");
    } finally {
      setLoading(false);
    }
  }

  function selectImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setNotice("Please select an image file.");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setNotice("Please select an image under 12 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImage(reader.result);
      setEnhanced(null);
      setNotice("Image loaded. Choose a processing option below.");
    };
    reader.readAsDataURL(file);
  }

  function processImage() {
    if (!image) return;
    const source = new Image();
    source.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      const context = canvas.getContext("2d");
      context.filter = "contrast(1.12) brightness(1.04)";
      context.drawImage(source, 0, 0);
      setEnhanced(canvas.toDataURL("image/png"));
      setNotice("Basic contrast enhancement applied. This is not AI restoration.");
    };
    source.src = image;
  }

  const filteredEvents = events.filter(
    (event) => filter === "All" || event.type === filter
  );

  const score = weather
    ? Math.max(0, Math.min(100, Math.round(
        100 - weather.clouds * 0.65 -
        (weather.humidity > 85 ? 12 : weather.humidity > 70 ? 6 : 0) -
        (weather.visibility < 5000 ? 20 : weather.visibility < 10000 ? 10 : 0)
      )))
    : null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-moon">☾</span>
          <div>
            <h2>TSUKUYOMI</h2>
            <small>THE CELESTIAL GUIDE</small>
          </div>
        </div>

        <div className="sidebar-label">YOUR OBSERVATORY</div>
        <nav>
          {navItems.map((item, index) => (
            <button
              key={item}
              className={`nav-item ${active === item ? "active" : ""}`}
              onClick={() => setActive(item)}
            >
              <span>{["◈", "⌖", "☄", "✧"][index]}</span>
              {item}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="moon-art">☾</div>
          <p>Look up.<br />Find your universe.</p>
          <small>THE NIGHT IS YOURS</small>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">月読 · THE MOON WATCHER</span>
            <h1>{active === "Overview" ? "Your celestial journey" : active}</h1>
          </div>
          <div className="status-pill"><span /> OBSERVATORY ONLINE</div>
        </header>

        {notice && <div className="notice">{notice}</div>}
        {weatherError && <div className="error-message">{weatherError}</div>}

        {active === "Overview" && (
          <>
            <section className="hero">
              <div className="hero-copy">
                <span className="eyebrow">YOUR WINDOW TO THE COSMOS</span>
                <h2>Beyond the<br />veil of <em>night.</em></h2>
                <p>Discover clear skies, follow celestial wonders, and explore the universe one night at a time.</p>
                <button className="primary-button" onClick={() => setActive("Watchtower")}>
                  Find clear skies <span>↗</span>
                </button>
              </div>
              <div className="hero-moon" aria-label="Decorative moon">
                <div className="moon-circle" />
                <span className="moon-star star-one">✦</span>
                <span className="moon-star star-two">✧</span>
                <span className="moon-star star-three">·</span>
                <div className="hero-caption">月の下で — UNDER THE MOON</div>
              </div>
            </section>

            <section className="section-heading">
              <div><span className="eyebrow">THE WATCHTOWER</span><h2>Tonight's conditions</h2></div>
              <button className="text-button" onClick={() => setActive("Watchtower")}>Explore weather ↗</button>
            </section>

            <section className="weather-panel">
              <div className="weather-search">
                <div>
                  <span className="eyebrow">OBSERVATION LOCATION</span>
                  <h3>{weather?.place || "Choose your city"}</h3>
                </div>
                <form onSubmit={(e) => { e.preventDefault(); fetchWeather(); }}>
                  <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Enter a city" aria-label="City name" />
                  <button className="primary-button" disabled={loading}>{loading ? "Loading..." : "Check skies"}</button>
                </form>
              </div>
              {weather ? (
                <>
                  <div className="score-row">
                    <div className="score-number">{score}<small>/100</small></div>
                    <div><span className="eyebrow">NIGHT HONOR SCORE</span><h3>{score >= 70 ? "Promising conditions" : score >= 40 ? "Mixed conditions" : "Cloudy skies"}</h3><p>Experimental estimate based on cloud cover, humidity and visibility.</p></div>
                  </div>
                  <div className="weather-grid">
                    <Metric icon="☁" label="Cloud cover" value={`${weather.clouds}%`} />
                    <Metric icon="◉" label="Humidity" value={`${weather.humidity}%`} />
                    <Metric icon="◎" label="Visibility" value={`${(weather.visibility / 1000).toFixed(1)} km`} />
                    <Metric icon="☼" label="Temperature" value={`${weather.temperature}°C`} />
                  </div>
                  <p className="fine-print">Weather is not a guarantee of sky quality. Light pollution, moonlight and local terrain are not included in this score.</p>
                </>
              ) : (
                <div className="empty-weather"><span>☾</span><p>Call the skies. Enter a city to retrieve current weather.</p><button className="primary-button" onClick={fetchWeather} disabled={loading}>{loading ? "Consulting the skies..." : "Load weather"}</button></div>
              )}
            </section>

            <section className="section-heading">
              <div><span className="eyebrow">THE CELESTIAL SCROLL</span><h2>Coming into view</h2></div>
              <button className="text-button" onClick={() => setActive("Celestial Scroll")}>All events ↗</button>
            </section>
            <EventList events={events.slice(0, 2)} />
          </>
        )}

        {active === "Watchtower" && (
          <>
            <p className="page-intro">Find your observation conditions. Search a city to get current weather data.</p>
            <section className="weather-panel">
              <div className="weather-search">
                <div><span className="eyebrow">LOCATION SEARCH</span><h3>{weather?.place || "Choose your city"}</h3></div>
                <form onSubmit={(e) => { e.preventDefault(); fetchWeather(); }}>
                  <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Enter a city" aria-label="City name" />
                  <button className="primary-button" disabled={loading}>{loading ? "Loading..." : "Check skies"}</button>
                </form>
              </div>
              {weather && <>
                <div className="score-row"><div className="score-number">{score}<small>/100</small></div><div><span className="eyebrow">NIGHT HONOR SCORE</span><h3>{score >= 70 ? "Promising conditions" : score >= 40 ? "Mixed conditions" : "Cloudy skies"}</h3><p>Experimental weather-based score, not a professional astronomy forecast.</p></div></div>
                <div className="weather-grid">
                  <Metric icon="☁" label="Cloud cover" value={`${weather.clouds}%`} />
                  <Metric icon="◉" label="Humidity" value={`${weather.humidity}%`} />
                  <Metric icon="◎" label="Visibility" value={`${(weather.visibility / 1000).toFixed(1)} km`} />
                  <Metric icon="☼" label="Temperature" value={`${weather.temperature}°C`} />
                </div>
              </>}
            </section>
            <section className="section-heading"><div><span className="eyebrow">FIELD NOTES</span><h2>Map & observation spots</h2></div></section>
            <div className="map-placeholder">
              <div className="map-decoration">山 · 月 · 神社</div>
              <span className="map-pin pin-one">⛩</span><span className="map-pin pin-two">▲</span><span className="map-pin pin-three">✦</span>
              <div className="map-message"><h3>The field map awaits</h3><p>Interactive map integration is the next build step.</p></div>
            </div>
          </>
        )}

        {active === "Celestial Scroll" && (
          <>
            <p className="page-intro">Keep watch on the heavens. Dates below are a starter dataset, not live verified event predictions.</p>
            <div className="filter-row">{["All", "Meteor Shower", "Moon Phase"].map((item) => <button key={item} className={`filter-button ${filter === item ? "selected" : ""}`} onClick={() => setFilter(item)}>{item}</button>)}</div>
            <EventList events={filteredEvents} />
            <div className="info-panel"><span>☾</span><div><h3>More celestial events soon</h3><p>Live event feeds, local moonrise times and event alerts will be added next.</p></div></div>
          </>
        )}

        {active === "Spirit Lens" && (
          <>
            <p className="page-intro">Bring a piece of the cosmos into the dojo. Start with a telescope or night-sky image.</p>
            <section className="lens-panel">
              <div className="lens-heading"><span className="eyebrow">THE SPIRIT LENS</span><h2>Reveal the hidden light.</h2><p>Upload an image to compare it with a basic contrast-enhanced version.</p></div>
              <label className="upload-box">
                <span className="upload-icon">✧</span><strong>Choose an astronomical image</strong><small>PNG, JPG or WebP · Maximum 12 MB</small>
                <input type="file" accept="image/*" onChange={selectImage} />
              </label>
              {image && <div className="image-workspace">
                <div className="image-pair">
                  <div><span className="eyebrow">ORIGINAL</span><img src={image} alt="Original astronomical upload" /></div>
                  {enhanced && <div><span className="eyebrow">BASIC ENHANCEMENT</span><img src={enhanced} alt="Contrast-enhanced image" /></div>}
                </div>
                <button className="primary-button" onClick={processImage}>Apply basic enhancement</button>
                <p className="fine-print">This uses simple contrast and brightness adjustments, not AI denoising. No fake stars or galaxies are added.</p>
              </div>}
            </section>
          </>
        )}

        <footer><span>☾ TSUKUYOMI WATCH</span><span>BUILT UNDER THE SAME MOON · 2026</span></footer>
      </main>
    </div>
  );
}

function Metric({ icon, label, value }) {
  return <div className="metric"><span className="metric-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}

function EventList({ events }) {
  if (!events.length) return <p className="page-intro">No events match this filter.</p>;
  return <div className="event-list">{events.map((event) => <article className="event-card" key={event.name}><div className="event-icon">{event.icon}</div><div className="event-copy"><span className="eyebrow">{event.type}</span><h3>{event.name}</h3><p>{event.detail}</p></div><div className="event-date">{event.date}</div></article>)}</div>;
}

export default App;

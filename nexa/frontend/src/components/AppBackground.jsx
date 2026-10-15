// Fixed full-screen background behind the whole app. It is a plain colour gradient driven
// by the user's colour scheme (Settings -> Appearance), so it never scrolls or moves.
export default function AppBackground() {
  return <div className="app-bg" aria-hidden="true" />;
}

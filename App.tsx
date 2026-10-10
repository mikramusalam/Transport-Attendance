import React, { useState, useEffect } from 'react';
import { Navigation, AppView } from './components/Navigation.js';
import { DriverAttendance } from './components/DriverAttendance.js';
import { AdminDashboard } from './components/AdminDashboard.js';
import { OfflineBanner } from './components/OfflineBanner.js';

// If deployed on a dedicated subdomain (admin.yourcompany.com vs
// attendance.yourcompany.com), lock the view to match — drivers should
// never see an admin link, and admins should land straight on the
// dashboard. On any other host (localhost, a single shared domain, etc.)
// both views are reachable via the switcher / #hash for convenience.
function hostLockedView(): AppView | null {
  const host = window.location.hostname;
  if (host.startsWith('admin.')) return 'admin';
  if (host.startsWith('attendance.')) return 'attendance';
  return null;
}

export default function App() {
  const locked = hostLockedView();

  const getViewFromHash = (): AppView => {
    if (locked) return locked;
    const hash = window.location.hash.replace('#', '').toLowerCase();
    if (hash === 'admin' || hash === 'dashboard') return 'admin';
    return 'attendance';
  };

  const [currentView, setCurrentView] = useState<AppView>(getViewFromHash);

  useEffect(() => {
    if (locked) return;
    const handleHashChange = () => setCurrentView(getViewFromHash());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [locked]);

  const handleSelectView = (view: AppView) => {
    if (locked) return;
    setCurrentView(view);
    window.location.hash = view;
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col font-sans selection:bg-blue-600 selection:text-white">
      <OfflineBanner />
      <Navigation currentView={currentView} onSelectView={handleSelectView} showSwitcher={!locked} />

      <main className="flex-1 pb-16">
        {currentView === 'attendance' && (
          <div className="animate-fade-in">
            <div className="max-w-xl mx-auto px-4 pt-4 text-center">
              <div className="bg-white border border-slate-200/80 rounded-full py-1.5 px-4 inline-flex items-center gap-2 text-xs text-slate-600 shadow-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-semibold text-slate-700">Daily GPS + Face Attendance System</span>
              </div>
            </div>
            <DriverAttendance />
          </div>
        )}

        {currentView === 'admin' && (
          <div className="animate-fade-in">
            <AdminDashboard />
          </div>
        )}
      </main>

      <footer className="bg-white border-t border-slate-200/80 py-4 px-4 mt-auto text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md bg-blue-600 flex items-center justify-center text-white">
              <div className="w-2 h-2 bg-white rounded-xs rotate-45" />
            </div>
            <span className="font-bold text-slate-700">FleetTrack Pro • Workforce Attendance</span>
          </div>
          <div className="text-[11px] text-slate-400">
            Biometric Verification • Real-time GPS Location
          </div>
        </div>
      </footer>
    </div>
  );
}

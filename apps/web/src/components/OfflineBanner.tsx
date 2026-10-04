import { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

export const OfflineBanner: React.FC = () => {
  const [isOffline, setIsOffline] = useState<boolean>(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!isOffline) {
    return null;
  }

  return (
    <div
      className="offline-banner"
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
    >
      <AlertTriangle size={16} aria-hidden="true" />
      <span>You're offline. Changes are safe and will sync when you reconnect.</span>
    </div>
  );
};

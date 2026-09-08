'use client';

import * as React from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SignOutButtonProps {
  className?: string;
  variant?: 'default' | 'primary' | 'copper' | 'outline' | 'ghost' | 'destructive';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  showText?: boolean;
  redirectTo?: string;
}

export function SignOutButton({
  className = '',
  variant = 'outline',
  size = 'sm',
  showText = true,
  redirectTo = '/',
}: SignOutButtonProps) {
  const [loading, setLoading] = React.useState(false);

  const handleSignOut = async () => {
    setLoading(true);
    try {
      await Promise.allSettled([
        fetch('/api/auth/me', { method: 'POST', credentials: 'same-origin' }),
        fetch('/api/auth/login', { method: 'DELETE', credentials: 'same-origin' }),
        fetch('/api/v1/auth/login', { method: 'DELETE', credentials: 'same-origin' }),
      ]);
    } catch (err) {
      console.warn('Sign out request failed:', err);
    }

    // Client-side cookie wipe for standard paths
    document.cookie = 'app_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0;';
    document.cookie = 'sa_original_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0;';
    document.cookie = 'team_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0;';

    window.location.replace(redirectTo);
  };

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleSignOut}
      disabled={loading}
      className={`font-mono text-xs transition-all ${className}`}
      title="Sign Out"
    >
      <LogOut className={`h-3.5 w-3.5 ${showText ? 'mr-1.5' : ''} ${loading ? 'animate-pulse' : ''}`} />
      {showText && (loading ? 'Signing out…' : 'Sign Out')}
    </Button>
  );
}

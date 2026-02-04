import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import type { GitHubAuthStatus } from '@/lib/api/types';
import { RiGithubFill, RiKeyLine, RiLoginCircleLine, RiInformationLine } from '@remixicon/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type GitHubUser = {
  login: string;
  id?: number;
  avatarUrl?: string;
  name?: string;
  email?: string;
};

type DeviceFlowStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  scope?: string;
};

type DeviceFlowCompleteResponse =
  | { connected: true; user: GitHubUser; scope?: string }
  | { connected: false; status?: string; error?: string };

export const GitHubSettings: React.FC = () => {
  const runtimeGitHub = getRegisteredRuntimeAPIs()?.github;
  const status = useGitHubAuthStore((state) => state.status);
  const isLoading = useGitHubAuthStore((state) => state.isLoading);
  const hasChecked = useGitHubAuthStore((state) => state.hasChecked);
  const refreshStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setStatus = useGitHubAuthStore((state) => state.setStatus);

  const openExternal = React.useCallback(async (url: string) => {
    if (typeof window === 'undefined') {
      return;
    }

    const desktop = (window as typeof window & { opencodeDesktop?: { openExternal?: (url: string) => Promise<unknown> } }).opencodeDesktop;
    if (desktop?.openExternal) {
      try {
        const result = await desktop.openExternal(url);
        if (result && typeof result === 'object' && 'success' in result && (result as { success?: boolean }).success === true) {
          return;
        }
      } catch {
        // fall through
      }
    }

    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // ignore
    }
  }, []);

  const [isBusy, setIsBusy] = React.useState(false);
  const [flow, setFlow] = React.useState<DeviceFlowStartResponse | null>(null);
  const [pollIntervalMs, setPollIntervalMs] = React.useState<number | null>(null);
  const pollTimerRef = React.useRef<number | null>(null);

  const [isPatDialogOpen, setIsPatDialogOpen] = React.useState(false);
  const [patToken, setPatToken] = React.useState('');

  const stopPolling = React.useCallback(() => {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setPollIntervalMs(null);
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        if (!hasChecked) {
          await refreshStatus(runtimeGitHub);
        }
      } catch (error) {
        console.warn('Failed to load GitHub auth status:', error);
      }
    })();
    return () => {
      stopPolling();
    };
  }, [hasChecked, refreshStatus, runtimeGitHub, stopPolling]);

  const startConnect = React.useCallback(async () => {
    setIsBusy(true);
    try {
      const payload = runtimeGitHub
        ? await runtimeGitHub.authStart()
        : await (async () => {
            const response = await fetch('/api/github/auth/start', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify({}),
            });
            const body = (await response.json().catch(() => null)) as DeviceFlowStartResponse | { error?: string } | null;
            if (!response.ok || !body || !('deviceCode' in body)) {
              throw new Error((body as { error?: string } | null)?.error || response.statusText);
            }
            return body;
          })();

      setFlow(payload);
      setPollIntervalMs(Math.max(1, payload.interval) * 1000);

      const url = payload.verificationUriComplete || payload.verificationUri;
      void openExternal(url);
    } catch (error) {
      console.error('Failed to start GitHub connect:', error);
      toast.error('Failed to start GitHub connect');
    } finally {
      setIsBusy(false);
    }
  }, [openExternal, runtimeGitHub]);

  const pollOnce = React.useCallback(async (deviceCode: string) => {
    if (runtimeGitHub) {
      return runtimeGitHub.authComplete(deviceCode) as Promise<DeviceFlowCompleteResponse>;
    }

    const response = await fetch('/api/github/auth/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ deviceCode }),
    });

    const payload = (await response.json().catch(() => null)) as DeviceFlowCompleteResponse | { error?: string } | null;
    if (!response.ok || !payload) {
      throw new Error((payload as { error?: string } | null)?.error || response.statusText);
    }
    return payload as DeviceFlowCompleteResponse;
  }, [runtimeGitHub]);

  React.useEffect(() => {
    if (!flow?.deviceCode || !pollIntervalMs) {
      return;
    }
    if (pollTimerRef.current != null) {
      return;
    }

    pollTimerRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const result = await pollOnce(flow.deviceCode);
            if (result.connected) {
              toast.success('GitHub connected');
              setFlow(null);
              stopPolling();
              await refreshStatus(runtimeGitHub, { force: true });
              return;
            }

          if (result.status === 'slow_down') {
            setPollIntervalMs((prev) => (prev ? prev + 5000 : 5000));
          }

          if (result.status === 'expired_token' || result.status === 'access_denied') {
            toast.error(result.error || 'GitHub authorization failed');
            setFlow(null);
            stopPolling();
          }
        } catch (error) {
          console.warn('GitHub polling failed:', error);
        }
      })();
    }, pollIntervalMs);

    return () => {
      if (pollTimerRef.current != null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [flow, pollIntervalMs, pollOnce, refreshStatus, runtimeGitHub, stopPolling]);

  const disconnect = React.useCallback(async () => {
    setIsBusy(true);
    try {
      stopPolling();
      setFlow(null);
      if (runtimeGitHub) {
        await runtimeGitHub.authDisconnect();
      } else {
        const response = await fetch('/api/github/auth', {
          method: 'DELETE',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(response.statusText);
        }
      }
      toast.success('GitHub disconnected');
      await refreshStatus(runtimeGitHub, { force: true });
    } catch (error) {
      console.error('Failed to disconnect GitHub:', error);
      toast.error('Failed to disconnect GitHub');
    } finally {
      setIsBusy(false);
    }
  }, [refreshStatus, runtimeGitHub, stopPolling]);

  const activateAccount = React.useCallback(async (accountId: string) => {
    if (!accountId) return;
    setIsBusy(true);
    try {
      const payload = runtimeGitHub
        ? await runtimeGitHub.authActivate(accountId)
        : await (async () => {
            const response = await fetch('/api/github/auth/activate', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify({ accountId }),
            });
            const body = (await response.json().catch(() => null)) as GitHubAuthStatus | { error?: string } | null;
            if (!response.ok || !body) {
              throw new Error((body as { error?: string } | null)?.error || response.statusText);
            }
            return body as GitHubAuthStatus;
          })();

      setStatus(payload);
      toast.success('GitHub account switched');
    } catch (error) {
      console.error('Failed to switch GitHub account:', error);
      toast.error('Failed to switch GitHub account');
    } finally {
      setIsBusy(false);
    }
  }, [runtimeGitHub, setStatus]);

  const handlePatLogin = React.useCallback(async () => {
    if (!patToken.trim()) return;
    setIsBusy(true);
    try {
      const payload = runtimeGitHub
        ? await runtimeGitHub.authWithToken(patToken.trim())
        : await (async () => {
            const response = await fetch('/api/github/auth/token', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify({ token: patToken.trim() }),
            });
            const body = (await response.json().catch(() => null)) as GitHubAuthStatus | { error?: string } | null;
            if (!response.ok || !body) {
              throw new Error((body as { error?: string } | null)?.error || response.statusText);
            }
            return body as GitHubAuthStatus;
          })();

      setStatus(payload);
      toast.success('GitHub connected via PAT');
      setIsPatDialogOpen(false);
      setPatToken('');
    } catch (error) {
      console.error('Failed to connect with PAT:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to connect with PAT');
    } finally {
      setIsBusy(false);
    }
  }, [patToken, runtimeGitHub, setStatus]);

  if (isLoading) {
    return null;
  }

  const connected = Boolean(status?.connected);
  const user = status?.user;
  const accounts = status?.accounts ?? [];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="typography-ui-header font-semibold text-foreground">GitHub</h3>
        <p className="typography-meta text-muted-foreground">
          Connect a GitHub account for in-app PR and issue workflows.
        </p>
      </div>

      {connected ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border bg-background/50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-4">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.login ? `${user.login} avatar` : 'GitHub avatar'}
                className="h-14 w-14 shrink-0 rounded-full border border-border/60 bg-muted object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="h-14 w-14 shrink-0 rounded-full border border-border/60 bg-muted" />
            )}

            <div className="min-w-0">
              <div className="typography-ui-header font-semibold text-foreground truncate">
                {user?.name?.trim() || user?.login || 'GitHub'}
              </div>
              {user?.email ? (
                <div className="typography-body text-muted-foreground truncate">{user.email}</div>
              ) : null}
              <div className="mt-1 flex items-center gap-2 typography-meta text-muted-foreground truncate">
                <RiGithubFill className="h-4 w-4" />
                <span className="font-mono">{user?.login || 'unknown'}</span>
              </div>
              {status?.scope ? (
                <div className="typography-micro text-muted-foreground truncate">Scopes: {status.scope}</div>
              ) : null}
            </div>
          </div>

          <Button variant="outline" onClick={disconnect} disabled={isBusy}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/50 px-3 py-2">
          <div className="typography-ui-label text-foreground">Not connected</div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button disabled={isBusy}>
                Connect
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={startConnect}>
                <RiLoginCircleLine className="mr-2 h-4 w-4" />
                Login using GitHub Auth Flow
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsPatDialogOpen(true)}>
                <RiKeyLine className="mr-2 h-4 w-4" />
                Login using Personal Access Token (PAT)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {connected ? (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" disabled={isBusy}>
                Add account
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={startConnect}>
                <RiLoginCircleLine className="mr-2 h-4 w-4" />
                Login using GitHub Auth Flow
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsPatDialogOpen(true)}>
                <RiKeyLine className="mr-2 h-4 w-4" />
                Login using Personal Access Token (PAT)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      <Dialog open={isPatDialogOpen} onOpenChange={setIsPatDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect with Personal Access Token</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 typography-ui-label text-foreground">
                <RiKeyLine className="h-4 w-4" />
                GitHub PAT
              </div>
              <Input
                type="password"
                placeholder="ghp_xxxxxxxxxxxx"
                value={patToken}
                onChange={(e) => setPatToken(e.target.value)}
                autoFocus
              />
              <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2 typography-meta text-muted-foreground">
                <RiInformationLine className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  Required scopes: <code className="text-foreground/80">repo</code>, <code className="text-foreground/80">read:org</code>, <code className="text-foreground/80">workflow</code>, <code className="text-foreground/80">read:user</code>, <code className="text-foreground/80">user:email</code>.
                  <br />
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo,read:org,workflow,read:user,user:email&description=OpenChamber"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block text-primary hover:underline"
                  >
                    Generate a token on GitHub &rarr;
                  </a>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsPatDialogOpen(false)} disabled={isBusy}>
              Cancel
            </Button>
            <Button onClick={handlePatLogin} disabled={!patToken.trim() || isBusy}>
              {isBusy ? 'Connecting...' : 'Connect Account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {accounts.length > 1 ? (
        <div className="space-y-2 rounded-lg border bg-background/50 p-3">
          <div className="typography-ui-label text-foreground">Accounts</div>
          <div className="space-y-2">
            {accounts.map((account) => {
              const accountUser = account.user;
              const isCurrent = Boolean(account.current);
              return (
                <div
                  key={account.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/70 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {accountUser?.avatarUrl ? (
                      <img
                        src={accountUser.avatarUrl}
                        alt={accountUser.login ? `${accountUser.login} avatar` : 'GitHub avatar'}
                        className="h-8 w-8 shrink-0 rounded-full border border-border/60 bg-muted object-cover"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted">
                        <RiGithubFill className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="typography-ui-label text-foreground truncate">
                        {accountUser?.name?.trim() || accountUser?.login || 'GitHub'}
                      </div>
                      {accountUser?.login ? (
                        <div className="typography-micro text-muted-foreground truncate font-mono">
                          {accountUser.login}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {isCurrent ? (
                    <span className="typography-micro text-primary">Active</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => activateAccount(account.id)}
                      disabled={isBusy}
                    >
                      Use
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {flow ? (
        <div className="space-y-3 rounded-lg border bg-background/50 p-3">
          <div className="space-y-1">
            <div className="typography-ui-label text-foreground">Authorize OpenChamber</div>
            <div className="typography-meta text-muted-foreground">
              In GitHub, enter this code:
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-lg tracking-widest text-foreground">{flow.userCode}</div>
            <Button variant="outline" asChild>
              <a
                href={flow.verificationUriComplete || flow.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open GitHub
              </a>
            </Button>
          </div>
          <div className="typography-micro text-muted-foreground">
            Waiting for approval… (auto-refresh)
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" disabled={isBusy} onClick={() => {
              stopPolling();
              setFlow(null);
            }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

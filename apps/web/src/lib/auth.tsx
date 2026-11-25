import { useEffect, useState, type ReactNode } from "react";
import { Button, Center, Loader, Stack, Text } from "@mantine/core";
import { InMemoryWebStorage, WebStorageStateStore } from "oidc-client-ts";
import { AuthProvider, useAuth } from "react-oidc-context";
import { setAuthHandlers } from "./api.ts";

/** Written by the CDK stack to /config.json. Absent in local development, which means no login. */
export interface RuntimeConfig {
  authority: string; // https://cognito-idp.<region>.amazonaws.com/<poolId>
  clientId: string;
  hostedUiDomain: string; // https://<prefix>.auth.<region>.amazoncognito.com
}

export async function loadRuntimeConfig(fetcher: typeof fetch = fetch): Promise<RuntimeConfig | null> {
  try {
    const res = await fetcher("/config.json", { cache: "no-store" });
    if (!res.ok) return null;
    const c = await res.json();
    return c?.authority && c?.clientId && c?.hostedUiDomain ? (c as RuntimeConfig) : null;
  } catch {
    return null; // the dev server answers with index.html, which isn't JSON
  }
}

export function signOutUrl(cfg: RuntimeConfig, origin: string) {
  return `${cfg.hostedUiDomain}/logout?${new URLSearchParams({ client_id: cfg.clientId, logout_uri: `${origin}/` })}`;
}

/** True at most once per 30 seconds. Storage failures count as allowed. */
export function allowReauth(store: Pick<Storage, "getItem" | "setItem">, now = Date.now()): boolean {
  try {
    const last = Number(store.getItem("reauth-at") ?? 0);
    if (now - last < 30_000) return false;
    store.setItem("reauth-at", String(now));
  } catch {
    /* ignore */
  }
  return true;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <Center h="100vh">
      <Stack align="center" gap="sm" role="status">
        {children}
      </Stack>
    </Center>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const here = () => window.location.pathname + window.location.search;

  // Registered during render, not in an effect: children's effects run first and start fetching,
  // and those first requests must already carry the token.
  setAuthHandlers({
    getToken: () => auth.user?.access_token,
    onUnauthorized: () => {
      // If we just signed in and the API still says 401, it's a configuration problem, not an
      // expired session: show the error instead of bouncing between the app and the login page.
      if (!allowReauth(window.sessionStorage)) return;
      void auth.signinRedirect({ state: here() });
    },
  });

  // Start login as soon as we know there is no session (and aren't mid-callback).
  useEffect(() => {
    if (!auth.isLoading && !auth.isAuthenticated && !auth.error && !auth.activeNavigator) {
      void auth.signinRedirect({ state: here() });
    }
  }, [auth.isLoading, auth.isAuthenticated, auth.error, auth.activeNavigator]);

  if (auth.error) {
    return (
      <Centered>
        <Text fw={600}>Sign-in failed</Text>
        <Text c="dimmed" size="sm">Something went wrong while signing in.</Text>
        <Button onClick={() => void auth.signinRedirect({ state: "/" })}>Try again</Button>
      </Centered>
    );
  }
  if (!auth.isAuthenticated) {
    return (
      <Centered>
        <Loader size="sm" />
        <Text c="dimmed" size="sm">Signing in…</Text>
      </Centered>
    );
  }
  return <>{children}</>;
}

/** Wraps the app in Cognito login when /config.json exists; otherwise renders it open (local dev). */
export function AuthGate({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<RuntimeConfig | null | undefined>(undefined);
  useEffect(() => {
    void loadRuntimeConfig().then(setCfg);
  }, []);

  if (cfg === undefined) return <Centered><Loader size="sm" /></Centered>;
  if (cfg === null) return <>{children}</>;

  return (
    <AuthProvider
      authority={cfg.authority}
      client_id={cfg.clientId}
      redirect_uri={`${window.location.origin}/`}
      scope="openid email profile"
      response_type="code" // authorization code with PKCE
      // Tokens live in memory only: nothing sensitive in localStorage, and a reload simply signs in again.
      userStore={new WebStorageStateStore({ store: new InMemoryWebStorage() })}
      stateStore={new WebStorageStateStore({ store: window.sessionStorage })}
      automaticSilentRenew
      onSigninCallback={(user) => {
        const back = typeof user?.state === "string" && user.state.startsWith("/") ? user.state : "/";
        window.history.replaceState({}, document.title, back);
      }}
    >
      <SignOutBridge cfg={cfg} />
      <Gate>{children}</Gate>
    </AuthProvider>
  );
}

let signOut: (() => void) | undefined;
/** Used by the header menu; undefined when login is off. */
export function getSignOut() {
  return signOut;
}

function SignOutBridge({ cfg }: { cfg: RuntimeConfig }) {
  const auth = useAuth();
  useEffect(() => {
    signOut = () => {
      void auth.removeUser().then(() => window.location.assign(signOutUrl(cfg, window.location.origin)));
    };
    return () => {
      signOut = undefined;
    };
  }, [auth, cfg]);
  return null;
}

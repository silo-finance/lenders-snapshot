import { useCallback, useEffect, useRef, useState } from "react";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

function getEthereumProvider(): EthereumProvider | null {
  const ethereum = (window as Window & { ethereum?: EthereumProvider }).ethereum;
  return ethereum ?? null;
}

function normalizeAccount(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    return null;
  }
  return value;
}

export function useWallet(onAccountConnected?: (address: string) => void) {
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const onAccountConnectedRef = useRef(onAccountConnected);

  useEffect(() => {
    onAccountConnectedRef.current = onAccountConnected;
  }, [onAccountConnected]);

  const notifyConnected = useCallback((address: string) => {
    onAccountConnectedRef.current?.(address);
  }, []);

  const connect = useCallback(async () => {
    const provider = getEthereumProvider();
    if (!provider) {
      return;
    }

    setConnecting(true);
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as unknown;
      const nextAccount = Array.isArray(accounts) ? normalizeAccount(accounts[0]) : null;
      setAccount(nextAccount);
      if (nextAccount) {
        notifyConnected(nextAccount);
      }
    } finally {
      setConnecting(false);
    }
  }, [notifyConnected]);

  useEffect(() => {
    const provider = getEthereumProvider();
    if (!provider) {
      return;
    }

    let cancelled = false;

    void provider.request({ method: "eth_accounts" }).then((accounts) => {
      if (cancelled || !Array.isArray(accounts) || accounts.length === 0) {
        return;
      }
      const nextAccount = normalizeAccount(accounts[0]);
      if (!nextAccount) {
        return;
      }
      setAccount(nextAccount);
      notifyConnected(nextAccount);
    });

    const handleAccountsChanged = (accounts: unknown) => {
      if (!Array.isArray(accounts) || accounts.length === 0) {
        setAccount(null);
        return;
      }
      const nextAccount = normalizeAccount(accounts[0]);
      setAccount(nextAccount);
      if (nextAccount) {
        notifyConnected(nextAccount);
      }
    };

    provider.on?.("accountsChanged", handleAccountsChanged);

    return () => {
      cancelled = true;
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
    };
  }, [notifyConnected]);

  return {
    account,
    connecting,
    connect,
    hasProvider: getEthereumProvider() !== null,
  };
}

"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import OAuthModal from "./OAuthModal";

/**
 * Muse Code auth: import the local `muse login` subscription key, or fall back
 * to device-code OAuth.
 */
export default function MetaAuthModal({ isOpen, providerInfo, onSuccess, onClose }) {
  const [phase, setPhase] = useState("detecting");
  const [detectResult, setDetectResult] = useState(null);
  const [error, setError] = useState(null);
  const [showDeviceCode, setShowDeviceCode] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      setPhase("detecting");
      setError(null);
      setDetectResult(null);
      setShowDeviceCode(false);
      try {
        const res = await fetch("/api/oauth/meta/auto-import");
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.found) {
          setDetectResult(data);
          setPhase("found");
        } else {
          setPhase("not-found");
          setError(data.error || "Muse Code is not logged in on this machine.");
        }
      } catch {
        if (!cancelled) {
          setPhase("not-found");
          setError("Failed to read local Muse Code credentials.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  const handleImport = async () => {
    setPhase("importing");
    setError(null);
    try {
      const res = await fetch("/api/oauth/meta/auto-import", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Import failed");
      }
      onSuccess?.(data.connection);
      onClose?.();
    } catch (err) {
      setPhase("found");
      setError(err.message || "Import failed");
    }
  };

  if (showDeviceCode) {
    return (
      <OAuthModal
        isOpen={isOpen}
        provider="meta"
        providerInfo={providerInfo}
        onSuccess={onSuccess}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Connect Muse Code" size="md">
      <div className="flex flex-col gap-4">
        {phase === "detecting" && (
          <p className="text-sm text-text-muted">Looking for a local Muse Code login…</p>
        )}
        {phase === "found" && (
          <>
            <p className="text-sm">
              Found a Muse Code subscription login
              {detectResult?.email ? <> for <strong>{detectResult.email}</strong></> : null}
              {detectResult?.source ? <> ({detectResult.source})</> : null}.
            </p>
            <p className="text-xs text-text-muted">
              This imports the CLI-minted subscription key. It is not a Model API PAYG key.
            </p>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setShowDeviceCode(true)}>
                Use device code instead
              </Button>
              <Button onClick={handleImport} disabled={phase === "importing"}>
                {phase === "importing" ? "Importing…" : "Import subscription"}
              </Button>
            </div>
          </>
        )}
        {(phase === "not-found" || phase === "importing") && phase !== "found" && (
          <>
            {phase === "importing" && <p className="text-sm text-text-muted">Importing…</p>}
            {phase === "not-found" && (
              <>
                <p className="text-sm">{error}</p>
                <p className="text-xs text-text-muted">
                  Run <code>muse login</code> in a terminal, then import, or start a device-code sign-in.
                </p>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                  <Button onClick={() => setShowDeviceCode(true)}>Sign in with device code</Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

MetaAuthModal.propTypes = {
  isOpen: PropTypes.bool,
  providerInfo: PropTypes.object,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func,
};

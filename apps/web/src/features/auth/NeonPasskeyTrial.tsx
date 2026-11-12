import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/client';
import { jwtClient } from 'better-auth/client/plugins';
import { useState } from 'react';

const auth = createAuthClient({
  baseURL: window.location.origin,
  plugins: [passkeyClient(), jwtClient()],
});

type TrialState = 'ready' | 'waiting' | 'passed' | 'failed';

export function NeonPasskeyTrial() {
  const [state, setState] = useState<TrialState>('ready');

  async function checkPasskey() {
    setState('waiting');
    try {
      const signIn = await auth.signIn.passkey();
      if (signIn.error) throw new Error('passkey_failed');
      const session = await auth.getSession();
      if (!session.data?.user?.id || session.error) throw new Error('session_missing');
      const jwt = await auth.token();
      if (!jwt.data?.token || jwt.error) throw new Error('jwt_missing');
      const encoded = jwt.data.token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
      if (!encoded) throw new Error('jwt_invalid');
      const payload = JSON.parse(atob(encoded)) as {
        sub?: string;
        role?: string;
      };
      if (payload.sub !== session.data.user.id || payload.role !== 'authenticated') {
        throw new Error('jwt_claims_invalid');
      }
      const dataApiUrl: unknown = import.meta.env.VITE_NEON_DATA_API_URL;
      if (typeof dataApiUrl !== 'string' || !dataApiUrl) {
        throw new Error('data_api_missing');
      }
      const response = await fetch(
        `${dataApiUrl.replace(/\/$/, '')}/app_documents?select=document_key&limit=1`,
        {
          headers: { Authorization: `Bearer ${jwt.data.token}` },
        },
      );
      if (!response.ok) throw new Error('data_api_failed');
      const documents: unknown = await response.json();
      if (!Array.isArray(documents) || documents.length !== 1) {
        throw new Error('document_access_failed');
      }
      const signOut = await auth.signOut();
      if (signOut.error) throw new Error('sign_out_failed');
      setState('passed');
    } catch {
      setState('failed');
    }
  }

  return (
    <main style={{ maxWidth: 560, margin: '10vh auto', padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Prueba de llave de paso en Neon</h1>
      <p>
        Comprueba tu llave existente en este dominio. La aplicación aún no cambiará de base de
        datos.
      </p>
      <button type="button" onClick={() => void checkPasskey()} disabled={state === 'waiting'}>
        {state === 'waiting' ? 'Esperando la llave…' : 'Probar llave de paso'}
      </button>
      {state === 'passed' ? (
        <p role="status">Inicio de sesión, token y lectura de Neon verificados.</p>
      ) : null}
      {state === 'failed' ? (
        <p role="alert">No se pudo verificar la llave. Inténtalo de nuevo.</p>
      ) : null}
    </main>
  );
}

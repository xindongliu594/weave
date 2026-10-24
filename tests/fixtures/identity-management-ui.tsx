import React from 'react';
import { createRoot } from 'react-dom/client';
import { IdentityManagement } from '../../apps/web/src/IdentityManagement.tsx';
import '../../apps/web/src/styles.css';

createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 1280, margin: '24px auto', padding: 24 }}>
  <IdentityManagement departments={[{ id: 'dept-a', name: '研发部' }, { id: 'dept-b', name: '运营部' }]}/>
</main>);

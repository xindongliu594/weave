import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import {IdentityGate} from './IdentityGate.tsx';
import './identity-reset.ts';
import './styles.css';

createRoot(document.getElementById('root')!).render(<IdentityGate><App/></IdentityGate>);

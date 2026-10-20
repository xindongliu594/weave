import {identitySession} from './identity-session.ts';
import {healthSync} from './health-sync.ts';
import {usageSync} from './usage-sync.ts';
import {projectSync} from './project-sync.ts';

identitySession.onReset(()=>{healthSync.reset();usageSync.reset();projectSync.reset();});

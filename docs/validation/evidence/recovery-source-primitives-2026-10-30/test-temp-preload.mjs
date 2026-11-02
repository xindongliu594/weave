import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
if(!process.env.ARCHIVE_SOURCE_TEMP)throw Error('ARCHIVE_SOURCE_TEMP is required');
os.tmpdir=()=>process.env.ARCHIVE_SOURCE_TEMP;
syncBuiltinESMExports();

import {createHash} from 'node:crypto';
export const pairingCode=value=>createHash('sha256').update(value).digest('hex').slice(0,8).toUpperCase();

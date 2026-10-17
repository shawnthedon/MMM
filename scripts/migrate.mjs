import { migrate } from '../apps/gateway/src/db.js';
migrate();
console.log('schema up to date');

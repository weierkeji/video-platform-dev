import { copyFileSync, cpSync } from 'node:fs';
copyFileSync('LICENSE', 'dist/LICENSE');
cpSync('third_party', 'dist/third_party', { recursive: true });
console.log('Preserved project and third-party notices in dist.');

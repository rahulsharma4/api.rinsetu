import { execSync } from 'child_process';
import fs from 'fs';

console.log('Starting npm install helper...');
try {
  const output = execSync('npm install bcryptjs node-cron xlsx --no-audit --no-fund', {
    encoding: 'utf-8',
    stdio: 'pipe'
  });
  fs.writeFileSync('install-result.txt', 'SUCCESS:\n' + output);
  console.log('Success! Saved output to install-result.txt');
} catch (error) {
  fs.writeFileSync('install-result.txt', 'ERROR:\n' + error.message + '\nSTDOUT:\n' + error.stdout + '\nSTDERR:\n' + error.stderr);
  console.error('Failed! Saved error to install-result.txt');
}

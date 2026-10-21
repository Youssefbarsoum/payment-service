import { existsSync } from 'node:fs';

// Local runs read .env. Docker and CI set the environment themselves and have
// no file. Variables already set are never overridden.
if (existsSync('.env')) process.loadEnvFile('.env');

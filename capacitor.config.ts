import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.smarttailoringsystem.pos',
  appName: 'SmartTailoringSystem',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    backgroundColor: '#0F172A',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;

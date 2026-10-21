import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { runSelfTest } from './selftest/run';

// The self-test runs once per app process, however often the screen mounts (Android
// can recreate the activity). scripts/selftest.mjs reads the LZ4_SELFTEST lines from
// the device log; the screen shows the same lines.
const lines: string[] = [];
const listeners = new Set<() => void>();
let result: Promise<boolean> | undefined;

function start(): Promise<boolean> {
  result ??= runSelfTest((line) => {
    console.log(`LZ4_SELFTEST ${line}`);
    lines.push(line);
    for (const listener of listeners) listener();
  }).catch((error: unknown) => {
    console.log(`LZ4_SELFTEST FAIL runner: ${String(error)}`);
    console.log('LZ4_SELFTEST DONE passed=0 failed=1');
    return false;
  });
  return result;
}

function App() {
  const [shown, setShown] = useState<string[]>(lines.slice());
  const [status, setStatus] = useState('running');
  useEffect(() => {
    const update = () => setShown(lines.slice());
    listeners.add(update);
    update();
    start().then((ok) => setStatus(ok ? 'passed' : 'failed'));
    return () => {
      listeners.delete(update);
    };
  }, []);
  return (
    <View style={styles.container}>
      <Text style={styles.title} testID="status">
        lz4-js self-test: {status}
      </Text>
      <ScrollView>
        {shown.map((line, i) => (
          <Text key={i} style={styles.line}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 64, paddingHorizontal: 16 },
  title: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
  line: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 12, marginBottom: 4 },
});

export default App;

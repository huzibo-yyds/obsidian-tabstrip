import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/unit/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			// The pure group model must stay well tested (step L3: at least 90 %).
			include: ['src/core/**/*.ts'],
			reporter: ['text', 'json-summary'],
			reportsDirectory: 'coverage',
			thresholds: {
				lines: 90,
				branches: 90,
				functions: 90,
				statements: 90,
			},
		},
	},
});

#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function assertIntegrationReport(report, requiredFiles) {
  if (!Array.isArray(requiredFiles) || requiredFiles.length === 0) throw new Error('At least one required integration file is required')
  if (report?.success !== true || report.numFailedTests > 0 || report.numFailedTestSuites > 0) throw new Error('Integration report did not succeed')
  if (!Array.isArray(report.testResults)) throw new Error('Integration report contains no test results')
  const results = []
  for (const file of requiredFiles) {
    const normalized = file.replaceAll('\\', '/')
    const suites = report.testResults.filter(suite => String(suite.name).replaceAll('\\', '/').endsWith(`/${normalized}`))
    const assertions = suites.flatMap(suite => suite.assertionResults ?? [])
    if (suites.length !== 1 || suites[0].status !== 'passed' || assertions.length === 0) throw new Error(`No passing assertions for required integration: ${file}`)
    const unexecuted = assertions.filter(assertion => assertion.status !== 'passed')
    if (unexecuted.length) throw new Error(`Required integration contains skipped, pending or failed assertions: ${file}`)
    results.push({ file, passed: assertions.length })
  }
  return results
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , reportPath, ...requiredFiles] = process.argv
  if (!reportPath) throw new Error('Usage: assert-integration-report.mjs report.json required-test-file ...')
  console.log(JSON.stringify(assertIntegrationReport(JSON.parse(await readFile(reportPath, 'utf8')), requiredFiles), null, 2))
}

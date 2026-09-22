import { describe, expect, test } from "bun:test"
import { applyClassifyResult } from "./learn-v2"

const single = {
  multi: false,
  correctIndices: [2],
  options: [
    { label: "in the office", value: "in the office" },
    { label: "in his field", value: "in his field" },
  ],
}

describe("applyClassifyResult", () => {
  test("timeout (null) yields empty incorrect", () => {
    expect(applyClassifyResult(single, null)).toEqual({ selectedIndices: [], dontKnow: false, correct: false })
  })

  test("isIDK yields dontKnow with reason", () => {
    expect(applyClassifyResult(single, { isIDK: true, reason: "genuine gap" })).toEqual({
      selectedIndices: [], dontKnow: true, correct: false, reason: "genuine gap",
    })
  })

  test("exact inferred hit", () => {
    expect(applyClassifyResult(single, { inferredIndices: [2], reason: "maps" })).toEqual({
      selectedIndices: [2], dontKnow: false, correct: true, reason: "maps",
    })
  })

  test("wrong inferred miss keeps the selection", () => {
    const r = applyClassifyResult(single, { inferredIndices: [1] })
    expect(r.selectedIndices).toEqual([1])
    expect(r.correct).toBe(false)
    expect(r.dontKnow).toBe(false)
  })

  test("single-select enforces the first of many inferred", () => {
    expect(applyClassifyResult(single, { inferredIndices: [2, 1] }).selectedIndices).toEqual([2])
  })

  test("multi-select keeps many inferred", () => {
    const r = applyClassifyResult({ ...single, multi: true, correctIndices: [1, 2] }, { inferredIndices: [1, 2] })
    expect(r.selectedIndices).toEqual([1, 2])
    expect(r.correct).toBe(true)
  })

  test("inferredValues map by value and drop unknowns", () => {
    const r = applyClassifyResult(single, { inferredValues: ["in his field", "nope"] })
    expect(r.selectedIndices).toEqual([2])
    expect(r.correct).toBe(true)
  })

  test("semanticCorrect overrides the exact match", () => {
    expect(applyClassifyResult(single, { inferredIndices: [1], semanticCorrect: true }).correct).toBe(true)
    expect(applyClassifyResult(single, { inferredIndices: [2], semanticCorrect: false }).correct).toBe(false)
  })

  test("out-of-range indices are dropped", () => {
    expect(applyClassifyResult(single, { inferredIndices: [9] })).toEqual({
      selectedIndices: [], dontKnow: false, correct: false, reason: undefined,
    })
  })
})

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RarityDot, rarityBucketForPct, rarityLabelForBucket } from './RarityDot';

describe('rarityBucketForPct (Phase 4.2E)', () => {
  it('20%+ → very-common', () => {
    expect(rarityBucketForPct(20)).toBe('very-common');
    expect(rarityBucketForPct(100)).toBe('very-common');
  });
  it('10..20% → common', () => {
    expect(rarityBucketForPct(10)).toBe('common');
    expect(rarityBucketForPct(15)).toBe('common');
  });
  it('5..10% → uncommon', () => {
    expect(rarityBucketForPct(5)).toBe('uncommon');
    expect(rarityBucketForPct(8)).toBe('uncommon');
  });
  it('1..5% → rare', () => {
    expect(rarityBucketForPct(1)).toBe('rare');
    expect(rarityBucketForPct(4)).toBe('rare');
  });
  it('<1% → very-rare', () => {
    expect(rarityBucketForPct(0)).toBe('very-rare');
    expect(rarityBucketForPct(0.5)).toBe('very-rare');
  });
});

describe('rarityLabelForBucket', () => {
  it('returns the human-readable label per bucket', () => {
    expect(rarityLabelForBucket('very-common')).toBe('very common');
    expect(rarityLabelForBucket('very-rare')).toBe('very rare');
    expect(rarityLabelForBucket('uncommon')).toBe('uncommon');
  });
});

describe('RarityDot', () => {
  afterEach(() => cleanup());

  it('renders a dot with the bucket modifier class', () => {
    render(<RarityDot bucket="common" />);
    const dot = screen.getByTestId('rarity-dot-common');
    expect(dot.className).toMatch(/rarity-dot--common/);
  });

  it('sets aria-label from the bucket label', () => {
    render(<RarityDot bucket="rare" />);
    const dot = screen.getByTestId('rarity-dot-rare');
    expect(dot.getAttribute('aria-label')).toBe('Rarity: rare');
  });

  it('accepts a custom title override', () => {
    render(<RarityDot bucket="very-rare" title="Only 1% chance" />);
    const dot = screen.getByTestId('rarity-dot-very-rare');
    expect(dot.getAttribute('title')).toBe('Only 1% chance');
  });
});

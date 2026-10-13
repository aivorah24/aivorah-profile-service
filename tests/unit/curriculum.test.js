const { normalizeCurriculum, normalizeCurriculumEntries, curriculumAliases } = require('../../utils/curriculum');

describe('normalizeCurriculum', () => {
  test.each(['NCERT', 'ncert', ' Ncert ', 'N CERT', 'CBSE', 'cbse'])('%p -> CBSE', (v) => {
    expect(normalizeCurriculum(v)).toBe('CBSE');
  });

  test('leaves other curricula untouched (trimmed)', () => {
    expect(normalizeCurriculum(' IB PYP ')).toBe('IB PYP');
    expect(normalizeCurriculum('NCERT Books')).toBe('NCERT Books');
    expect(normalizeCurriculum(null)).toBeNull();
    expect(normalizeCurriculum(undefined)).toBeUndefined();
  });

  test('normalizeCurriculumEntries maps teaches/children entries', () => {
    expect(normalizeCurriculumEntries([{ grade: 'Grade 8', curriculum: 'NCERT' }, { grade: 'Grade 3' }]))
      .toEqual([{ grade: 'Grade 8', curriculum: 'CBSE' }, { grade: 'Grade 3' }]);
    expect(normalizeCurriculumEntries(undefined)).toBeUndefined();
  });

  test('curriculumAliases keeps legacy NCERT rows matchable', () => {
    expect(curriculumAliases('ncert')).toEqual(['CBSE', 'NCERT']);
    expect(curriculumAliases('IB PYP')).toEqual(['IB PYP']);
  });
});

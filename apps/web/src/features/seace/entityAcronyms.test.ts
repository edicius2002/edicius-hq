import { describe, expect, it } from 'vitest';

import { uniqueEntityAcronym } from './entityAcronyms';

describe('unique SEACE entity abbreviations', () => {
  it('matches documented names and accents within Arequipa', () => {
    expect(
      uniqueEntityAcronym('  servicio de agua potable y alcantarillado de arequipa  ', 'Arequipa'),
    ).toBe('SEDAPAR S.A');
    expect(uniqueEntityAcronym('Municipalidad Distrital de Uñon', 'Arequipa')).toBe('MD-UÑON');
    expect(
      uniqueEntityAcronym('EMPRESA DE GENERACION ELECTRICA DE AREQUIPA S.A.', 'Arequipa'),
    ).toBe('EGASA');
  });

  it('keeps shared and unknown names in full, including outside Arequipa', () => {
    expect(uniqueEntityAcronym('Municipalidad Distrital de Caylloma', 'Arequipa')).toBeNull();
    expect(uniqueEntityAcronym('Municipalidad Distrital de Atiquipa', 'Arequipa')).toBeNull();
    expect(uniqueEntityAcronym('Municipalidad Distrital de Uñon', 'Cusco')).toBeNull();
  });
});

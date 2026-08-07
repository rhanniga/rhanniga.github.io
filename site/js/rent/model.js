// @ts-check
/**
 * Rent vs. buy: the arithmetic.
 *
 * A port of the Streamlit calculator this grew out of, kept deliberately
 * line-for-line faithful to it so the two agree to the cent -- with one
 * difference, which is the whole reason it was worth porting rather than
 * linking to:
 *
 *   The Streamlit version reports the terminal gap in *nominal* dollars. At a
 *   4% inflation assumption over a 10-year hold, that number is 32% larger than
 *   the thing it claims to measure, and the error grows with exactly the
 *   parameter (the holding period) the visitor is most likely to sweep. So every
 *   series here carries a `real` value alongside the nominal one, deflated at
 *   general inflation back to year 0, and the widget reports the real gap.
 *
 * Pure functions over plain numbers: no DOM, no formatting, no rounding. The
 * widget owns presentation, and this owns the model.
 */

/**
 * Every knob, in model units -- rates are fractions (0.065), not percentages.
 *
 * @typedef {object} Params
 * @property {number} initialPortfolio   invested assets at year 0, assumed at basis
 * @property {number} annualInvestment   new money added each year, to both sides
 * @property {number} homeCost           purchase price
 * @property {number} downPaymentPct     fraction of price paid in cash
 * @property {number} loanRate           annual fixed mortgage rate
 * @property {number} loanTermYears      amortization term
 * @property {number} horizonYears       years held before selling
 * @property {number} monthlyRent        year-1 rent
 * @property {number} stockRoi           annual return on invested assets
 * @property {number} houseRoi           annual home-price growth
 * @property {number} inflation          growth of ownership costs; also the deflator
 * @property {number} rentInflation      growth of rent, tracked separately
 * @property {number} buyingFeePct       one-time closing costs, as a % of price
 * @property {number} sellingFeePct      one-time cost to sell, as a % of sale price
 * @property {number} maintenancePct     annual upkeep, as a % of original price
 * @property {number} insurancePct       annual insurance, as a % of original price
 * @property {number} taxesPct           annual property tax, as a % of original price
 * @property {number} hoaMonthly         monthly HOA dues
 * @property {number} capGainsRate       long-term rate applied at exit
 * @property {number} incomeTaxRate      marginal rate, for valuing the itemized deduction
 * @property {number} stdDeduction       the hurdle itemizing has to clear
 * @property {number} saltCap            ceiling on deductible property tax
 * @property {number} mortgageDeductCap  principal above which interest stops being deductible
 * @property {number} homeGainExclusion  home-sale profit shielded from capital gains
 */

/**
 * One year of the amortization schedule.
 * @typedef {object} LoanYear
 * @property {number} interest
 * @property {number} principal
 * @property {number} payment
 * @property {number} endBalance   what is still owed if you sell now
 */

/**
 * One year of the comparison: net worth if you exited at the END of that year.
 * @typedef {object} YearRow
 * @property {number} year
 * @property {number} buy        nominal, i.e. year-`year` dollars
 * @property {number} rent
 * @property {number} buyReal    the same figure in year-0 dollars
 * @property {number} rentReal
 */

/**
 * @typedef {object} Result
 * @property {YearRow[]} rows              one per year, 1..horizon
 * @property {number} monthlyPayment       fixed nominal mortgage payment
 * @property {number} downPayment
 * @property {number} loanAmount
 * @property {number | null} crossover     first year buying leads and keeps leading
 */

/**
 * Amortize the loan over `termYears`, reporting `horizonYears` of rows.
 *
 * Term and horizon are independent: if the horizon is shorter, the last row's
 * `endBalance` is the payoff owed at sale; if it is longer, the years past payoff
 * have no payment and no interest.
 *
 * @param {number} loanAmount
 * @param {number} annualRate
 * @param {number} termYears
 * @param {number} horizonYears
 * @returns {{ monthlyPayment: number, rows: LoanYear[] }}
 */
export function amortize(loanAmount, annualRate, termYears, horizonYears) {
  const r = annualRate / 12;
  const n = Math.max(1, Math.round(termYears * 12));
  const monthlyPayment =
    r > 0
      ? (loanAmount * (r * (1 + r) ** n)) / ((1 + r) ** n - 1)
      : loanAmount / n;

  let balance = loanAmount;
  /** @type {LoanYear[]} */
  const rows = [];

  for (let y = 1; y <= horizonYears; y++) {
    let interest = 0;
    let principal = 0;
    // The 1e-6 floor rather than `> 0`: floating-point residue on a paid-off loan
    // would otherwise keep accruing a fraction of a cent of interest for decades.
    if (y <= termYears && balance > 1e-6) {
      for (let m = 0; m < 12; m++) {
        const monthInterest = balance * r;
        let monthPrincipal = monthlyPayment - monthInterest;
        if (monthPrincipal > balance) monthPrincipal = balance; // trim the last payment
        balance -= monthPrincipal;
        interest += monthInterest;
        principal += monthPrincipal;
      }
    }
    rows.push({ interest, principal, payment: interest + principal, endBalance: balance });
  }

  return { monthlyPayment, rows };
}

/**
 * What a taxable portfolio is worth if sold today.
 *
 * Gains are taxed; losses earn no credit, which is the conservative reading and
 * matches the Streamlit original.
 *
 * @param {number} value
 * @param {number} basis
 * @param {number} capGainsRate
 * @returns {number}
 */
export function afterTaxLiquidation(value, basis, capGainsRate) {
  const gain = Math.max(0, value - Math.max(basis, 0));
  return value - gain * capGainsRate;
}

/**
 * Run the comparison.
 *
 * Both columns are "after-tax, after-transaction-cost net worth if you exited at
 * the end of this year", which is the only comparison that is honest about the
 * ~11% round trip on buying and about the renter's untaxed unrealized gains.
 *
 * @param {Params} p
 * @returns {Result}
 */
export function simulate(p) {
  const horizon = Math.max(1, Math.round(p.horizonYears));
  const downPayment = p.homeCost * p.downPaymentPct;
  const loanAmount = p.homeCost - downPayment;
  const buyingFee = p.homeCost * p.buyingFeePct;

  const { monthlyPayment, rows: sched } = amortize(
    loanAmount,
    p.loanRate,
    Math.round(p.loanTermYears),
    horizon,
  );

  // Interest is deductible only on the first `mortgageDeductCap` of principal, so
  // borrowing past the cap dilutes the benefit proportionally.
  const deductRatio = loanAmount > 0 ? Math.min(1, p.mortgageDeductCap / loanAmount) : 0;

  // Both portfolios track market value AND cost basis, so gains can be taxed on
  // the way out. The initial portfolio is assumed to sit at basis, which is what
  // makes seeding the down payment from it tax-free at year 0.
  let renterValue = p.initialPortfolio;
  let renterBasis = p.initialPortfolio;
  let buyerValue = p.initialPortfolio - downPayment - buyingFee;
  let buyerBasis = buyerValue;

  let homeValue = p.homeCost;
  const homeBasis = p.homeCost + buyingFee; // closing costs capitalized into basis

  let annualRent = p.monthlyRent * 12;
  let annualMaintenance = p.homeCost * p.maintenancePct;
  let annualInsurance = p.homeCost * p.insurancePct;
  let annualTaxes = p.homeCost * p.taxesPct;
  let annualHoa = p.hoaMonthly * 12;

  /** @type {YearRow[]} */
  const rows = [];

  for (let year = 1; year <= horizon; year++) {
    const yr = sched[year - 1] ?? { interest: 0, principal: 0, payment: 0, endBalance: 0 };

    const holdingCosts = annualMaintenance + annualInsurance + annualTaxes + annualHoa;

    // The itemized benefit is only the part that clears the standard deduction.
    // In a no-income-tax state property tax is effectively the only SALT item.
    const deductibleInterest = yr.interest * deductRatio;
    const salt = Math.min(annualTaxes, p.saltCap);
    const taxSaving = Math.max(0, deductibleInterest + salt - p.stdDeduction) * p.incomeTaxRate;

    const buyerOutflow = yr.payment + holdingCosts - taxSaving;

    // Grow first (gains stay unrealized), then apply the year's cash flows.
    renterValue = renterValue * (1 + p.stockRoi) - annualRent + p.annualInvestment;
    renterBasis = renterBasis - annualRent + p.annualInvestment;

    buyerValue = buyerValue * (1 + p.stockRoi) - buyerOutflow + p.annualInvestment;
    buyerBasis = buyerBasis - buyerOutflow + p.annualInvestment;

    homeValue *= 1 + p.houseRoi;

    /* ── Net worth if you exit at the end of this year ── */
    const rentNw = afterTaxLiquidation(renterValue, renterBasis, p.capGainsRate);

    const sellingFee = homeValue * p.sellingFeePct;
    const homeGain = homeValue - sellingFee - homeBasis;
    const homeTax = Math.max(0, homeGain - p.homeGainExclusion) * p.capGainsRate;

    const buyNw =
      afterTaxLiquidation(buyerValue, buyerBasis, p.capGainsRate) +
      homeValue -
      sellingFee -
      yr.endBalance -
      homeTax;

    // Deflating by general inflation is the assumption being made, stated once
    // here: it treats the visitor's alternative use of the money as tracking CPI.
    const deflator = (1 + p.inflation) ** year;
    rows.push({
      year,
      buy: buyNw,
      rent: rentNw,
      buyReal: buyNw / deflator,
      rentReal: rentNw / deflator,
    });

    annualRent *= 1 + p.rentInflation;
    annualMaintenance *= 1 + p.inflation;
    annualInsurance *= 1 + p.inflation;
    annualTaxes *= 1 + p.inflation;
    annualHoa *= 1 + p.inflation;
  }

  return { rows, monthlyPayment, downPayment, loanAmount, crossover: findCrossover(rows) };
}

/**
 * The first year buying pulls ahead **and stays ahead**.
 *
 * "And stays ahead" is the part that matters: a bare first-crossing can land in a
 * year where buying leads by a rounding error and loses again immediately, which
 * would advertise a break-even that is not one.
 *
 * Computed on nominal values, which is safe: both columns are deflated by the same
 * positive factor, so the ordering is identical in real terms.
 *
 * @param {YearRow[]} rows
 * @returns {number | null}
 */
function findCrossover(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows.slice(i).every((r) => r.buy >= r.rent)) return rows[i]?.year ?? null;
  }
  return null;
}

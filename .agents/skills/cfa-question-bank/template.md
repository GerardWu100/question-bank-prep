# CFA L2 · 01 Quantitative Methods · JC 100 Combined

Extracted from `md_materials/JC 100 Combined/01. Quantitative Methods - Q+A/01. Quantitative Methods - Q+A.md`. Questions are copied word for word; only the layout changed.

# Chapter LM01 Basics of Multiple Regression and Underlying Assumptions

## Case QM-JC100-C01 Laurant Davidson

Laurant Davidson, CFA, a quantitative analyst, forecasts sales with a multiple regression:

$$
Y_{\mathrm{PROB}} = 0 - 0.04X_{\mathrm{ACT}} + 0.008X_{\mathrm{AGE}}
$$

### Exhibit 1: Regression Inputs

| Input | Value |
|---|---|
| Observations | 40 |
| Price per unit | \$25.00 |

### Question QM-JC100-C01-1

Which of the following is least likely an assumption of multiple linear regression?

#### Choices

A. There is no exact linear relation between two or more of the independent variables.

B. The variances of the regression residuals are normally distributed.

C. The regression residuals are uncorrelated across observations.

#### Answer

B

#### Solution

The correct assumption is that residual variances are the same across all observations (homoskedasticity).

*Source: JC 100 Combined, Case 1, Question 1.*

### Question QM-JC100-C01-2

Based on the regression model, which statement is most likely correct?

#### Choices

A. The probability is positively correlated with activity levels.

B. A one-unit increase in $X_{\mathrm{AGE}}$ raises $Y_{\mathrm{PROB}}$ by 0.008.

C. $Y_{\mathrm{PROB}}$ is more sensitive to $X_{\mathrm{ACT}}$ than to $X_{\mathrm{AGE}}$.

#### Answer

C

#### Solution

The magnitude of the $X_{\mathrm{ACT}}$ slope (0.04) is larger than that of $X_{\mathrm{AGE}}$ (0.008).

*Source: JC 100 Combined, Case 1, Question 2.*

# Chapter LM03 Model Misspecification

## Question QM-QB25-1586011

The regression exhibits conditional heteroskedasticity, serial correlation, and multicollinearity. The analyst uses White and Newey-West corrected standard errors. Which of the following is most accurate?

### Choices

A. The regression will still exhibit heteroskedasticity and multicollinearity.

B. The regression will still exhibit multicollinearity, but the other two problems are solved.

C. The regression will still exhibit serial correlation and multicollinearity.

### Answer

B

### Solution

Corrected standard errors fix inference under heteroskedasticity and serial correlation; they do nothing for multicollinearity.

*Source: Qbank 2025, Question ID 1586011; Module 1.3, LOS 1.f.*

## Question QM-QB25-1479906

Which of the following is least likely a method used to detect heteroskedasticity?

### Choices

A. Scatter plot.

B. Breusch-Pagan test.

C. Breusch-Godfrey test.

### Solution

> Key not given in source.

*Source: Qbank 2025, Question ID 1479906.*

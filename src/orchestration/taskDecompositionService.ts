/**
 * NEXUS AI — Task Decomposition Service
 *
 * Intelligently analyzes user goals and derives coherent, bounded,
 * dependency-linked child tasks for medium and large projects.
 * Keeps small requests small (1-3 units) and breaks large composite
 * requests into structured units with explicit verification criteria.
 */

import type { ModelGateway } from '../intelligence/modelGateway.js';
import type {
  DecomposedTaskUnit,
  DecompositionPlan,
  DecomposeOptions,
} from './taskDecompositionTypes.js';
import { extractBrandCandidates } from './placeholderDetector.js';
import { Logger, LogLevel } from '../common/logger.js';

export class TaskDecompositionService {
  private logger: Logger;

  constructor(
    private modelGateway?: ModelGateway,
    logLevel: LogLevel = 'info'
  ) {
    this.logger = new Logger('TaskDecompositionService', logLevel);
  }

  /**
   * Analyze goal and produce a decomposition plan.
   */
  async decompose(options: DecomposeOptions): Promise<DecompositionPlan> {
    const goal = options.taskGoal.trim();
    this.logger.info(`Analyzing goal for decomposition`, { goalLength: goal.length });

    // 1. Check complexity
    const complexity = this.estimateComplexity(goal);

    if (complexity === 'low' && !options.forceDecompose) {
      this.logger.info(`Goal classified as low complexity -> single unit execution`);
      return {
        parentGoal: goal,
        isDecomposed: false,
        estimatedComplexity: 'low',
        reasoning: 'Goal is a focused, single-operation task that does not require decomposition.',
        units: [
          {
            id: 'unit-1-main',
            title: goal.length > 50 ? `${goal.slice(0, 47)}...` : goal,
            description: goal,
            category: 'component',
            dependencies: [],
            targetFiles: this.inferTargetFiles(goal),
            expectedOutput: 'Complete implementation fulfilling the requested goal.',
            verificationCriteria: ['Valid syntax and output', 'No placeholder content'],
          },
        ],
      };
    }

    // 2. Medium or High Complexity: Generate structured decomposition plan
    const plan = this.generateDecompositionPlan(goal, complexity);
    this.logger.info(`Decomposed into ${plan.units.length} coherent units`, {
      complexity: plan.estimatedComplexity,
      unitTitles: plan.units.map((u) => u.title),
    });

    return plan;
  }

  /**
   * Estimate complexity based on linguistic structure, section keywords, and project scope.
   */
  estimateComplexity(goal: string): 'low' | 'medium' | 'high' {
    const lower = goal.toLowerCase();

    // Check for explicit multi-section keywords
    const sectionKeywords = [
      'navbar', 'header', 'hero', 'features', 'solutions', 'dashboard',
      'testimonials', 'pricing', 'faq', 'cta', 'footer', 'menu', 'about',
      'contact', 'gallery', 'portfolio', 'services', 'reviews', 'calculator',
    ];

    const matchedSections = sectionKeywords.filter((k) => lower.includes(k));

    const isLargeProject =
      lower.includes('landing page') ||
      lower.includes('landing website') ||
      lower.includes('website') ||
      lower.includes('web page') ||
      lower.includes('webpage') ||
      lower.includes('web application') ||
      lower.includes('webapp') ||
      lower.includes('web app') ||
      lower.includes('full stack') ||
      lower.includes('platform') ||
      lower.includes('dashboard') ||
      lower.includes('saas');

    if (matchedSections.length >= 4 || (isLargeProject && matchedSections.length >= 2)) {
      return 'high';
    }

    if (matchedSections.length >= 2 || isLargeProject || lower.includes('calculator')) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Generate structured decomposition plan with dependencies.
   */
  private generateDecompositionPlan(
    goal: string,
    complexity: 'low' | 'medium' | 'high'
  ): DecompositionPlan {
    const lower = goal.toLowerCase();
    const brandName = this.extractBrandName(goal);
    const reqFolder = this.extractRequestedFolder(goal);
    const prefix = reqFolder ? `${reqFolder}/` : '';
    const units: DecomposedTaskUnit[] = [];

    // ── CASE A: Calculator Project ───────────────────────────────────────────
    if (lower.includes('calculator')) {
      units.push({
        id: 'unit-1-foundation',
        title: 'Calculator UI Structure',
        description: `Build complete semantic HTML skeleton and display grid for the calculator application (${brandName || 'Modern Calculator'}) in ${reqFolder || 'project root'}.`,
        category: 'foundation',
        dependencies: [],
        targetFiles: [`${prefix}index.html`],
        expectedOutput: 'Clean HTML with display, number keypad (0-9), operator buttons (+, -, *, /), clear, and equals buttons.',
        verificationCriteria: ['index.html contains complete display and button keypad', 'No placeholder comments'],
      });

      units.push({
        id: 'unit-2-logic',
        title: 'Calculator Computation Logic',
        description: `Implement calculator state machine, button click handlers, operations (+, -, *, /), keyboard events, and display updates in JavaScript (${prefix}script.js).`,
        category: 'logic',
        dependencies: ['unit-1-foundation'],
        targetFiles: [`${prefix}script.js`, `${prefix}index.html`],
        expectedOutput: 'Working JavaScript arithmetic engine supporting addition, subtraction, multiplication, division, decimal input, and clear.',
        verificationCriteria: ['script.js contains real event listeners and arithmetic functions', 'index.html connects script.js'],
      });

      units.push({
        id: 'unit-3-styling',
        title: 'Calculator Responsive Styling',
        description: `Implement modern aesthetic styling, CSS grid layout, responsive dimensions, button hover/active states, and dark theme in CSS (${prefix}style.css).`,
        category: 'styling',
        dependencies: ['unit-1-foundation'],
        targetFiles: [`${prefix}style.css`, `${prefix}index.html`],
        expectedOutput: 'Polished CSS styling with glassmorphism or sleek dark mode theme, centered layout, and responsive keypad.',
        verificationCriteria: ['style.css contains real layout rules and color variables', 'index.html links style.css'],
      });

      units.push({
        id: 'unit-4-integration',
        title: 'Calculator Integration & Verification',
        description: 'Verify end-to-end integration between HTML, CSS, and JS. Ensure calculation display and buttons are fully interactive.',
        category: 'integration',
        dependencies: ['unit-1-foundation', 'unit-2-logic', 'unit-3-styling'],
        targetFiles: [`${prefix}index.html`, `${prefix}style.css`, `${prefix}script.js`],
        expectedOutput: '100% complete, fully verified calculator ready for live preview.',
        verificationCriteria: ['All 3 files exist and are valid', 'No unresolved references or placeholders'],
      });

      return {
        parentGoal: goal,
        isDecomposed: true,
        estimatedComplexity: complexity,
        reasoning: 'Decomposed into UI structure, calculation logic, responsive styling, and end-to-end integration.',
        units,
      };
    }

    // ── CASE B: Web Landing Page / SaaS / Brand / Portfolio ──────────────────
    const targetBrand = brandName || 'Modern Tech';

    // 1. Foundation
    units.push({
      id: 'unit-1-foundation',
      title: 'Project Foundation & Base Layout',
      description: `Scaffold complete, semantic HTML5 structure for ${targetBrand} including meta tags, responsive viewport, Google Fonts, and base CSS variables with full rich markup. Do not output placeholder comments or empty skeleton tags.`,
      category: 'foundation',
      dependencies: [],
      targetFiles: ['index.html', 'styles.css'],
      expectedOutput: `Valid HTML5 document with title containing '${targetBrand}', linked stylesheets, and CSS design tokens.`,
      verificationCriteria: ['index.html has DOCTYPE, head, title, and body', 'styles.css has root color tokens and reset rules'],
    });

    // 2. Navigation Bar
    units.push({
      id: 'unit-2-navbar',
      title: 'Navigation Header & Brand Identity',
      description: `Implement sticky header navbar with ${targetBrand} brand logo, navigation links, and primary action button.`,
      category: 'component',
      dependencies: ['unit-1-foundation'],
      targetFiles: ['index.html', 'styles.css'],
      expectedOutput: `Header element with brand logo '${targetBrand}', navigation links, and responsive styling.`,
      verificationCriteria: ['header or nav element exists', `${targetBrand} brand text present`, 'Navigation links styled and visible'],
    });

    // 3. Hero Section
    units.push({
      id: 'unit-3-hero',
      title: 'Hero Section & Value Proposition',
      description: `Create high-impact Hero banner with headline, sub-headline, primary and secondary CTA buttons, and key visual highlights for ${targetBrand}.`,
      category: 'component',
      dependencies: ['unit-2-navbar'],
      targetFiles: ['index.html', 'styles.css'],
      expectedOutput: 'Rich hero section with bold typography, value proposition paragraph, action buttons, and accent styling.',
      verificationCriteria: ['hero section exists with h1 heading', 'CTA buttons present with real text', 'No placeholder comments'],
    });

    // 4. Features Section
    units.push({
      id: 'unit-4-features',
      title: 'Core Features & Capabilities',
      description: `Build comprehensive features grid with 4 to 6 distinct capability cards showcasing ${targetBrand}'s unique advantages.`,
      category: 'component',
      dependencies: ['unit-3-hero'],
      targetFiles: ['index.html', 'styles.css'],
      expectedOutput: 'Features grid with at least 4 feature cards containing distinct icons/titles/descriptions.',
      verificationCriteria: ['features section exists', 'At least 3 feature cards with real paragraphs', 'Clean CSS grid or flex layout'],
    });

    // 5. Solutions / Menu / Specialty Section
    const normalized = goal.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const isCafe =
      lower.includes('cafe') ||
      lower.includes('café') ||
      normalized.includes('cafe') ||
      lower.includes('coffee') ||
      lower.includes('brew') ||
      lower.includes('roastery') ||
      lower.includes('restaurant') ||
      lower.includes('bakery') ||
      lower.includes('bistro');
    if (isCafe) {
      units.push({
        id: 'unit-5-menu',
        title: 'Artisanal Menu & Offerings',
        description: `Implement curated cafe menu section with categorized beverages, artisanal bakes, pricing, and origin details for ${targetBrand}.`,
        category: 'component',
        dependencies: ['unit-4-features'],
        targetFiles: ['index.html', 'styles.css'],
        expectedOutput: 'Menu section displaying categorized specialty coffees, signature brews, and pricing.',
        verificationCriteria: ['menu section exists with real item names and prices', 'Visual card styling for menu items'],
      });
    } else {
      units.push({
        id: 'unit-5-solutions',
        title: 'Enterprise Solutions & Architecture',
        description: `Implement solutions showcase with architecture highlights, workflow diagrams, and integration capabilities for ${targetBrand}.`,
        category: 'component',
        dependencies: ['unit-4-features'],
        targetFiles: ['index.html', 'styles.css'],
        expectedOutput: 'Solutions section detailing enterprise use cases, platform integrations, and scalability highlights.',
        verificationCriteria: ['solutions section exists with detailed content', 'Interactive tabs or grid cards styled in CSS'],
      });
    }

    // 6. Interactive Module / Dashboard Preview
    if (
      /\b(?:dashboard|analytics|live metrics)\b/i.test(lower) ||
      (/\b(?:product|platform)\b/i.test(lower) && !/\b(?:production|production-quality)\b/i.test(lower)) ||
      lower.includes('nexora') ||
      lower.includes('saas')
    ) {
      units.push({
        id: 'unit-6-dashboard',
        title: 'Interactive Product Dashboard Visual',
        description: `Build interactive dashboard preview with real-time metrics cards, chart visualizations, active nodes status, and control toggles for ${targetBrand}.`,
        category: 'component',
        dependencies: ['unit-5-solutions', 'unit-5-menu'].filter((dep) => units.some((u) => u.id === dep)),
        targetFiles: ['index.html', 'styles.css', 'scripts.js'],
        expectedOutput: 'Dashboard component with live metrics, latency/throughput counters, and interactive visual widgets.',
        verificationCriteria: ['dashboard container exists with metrics items', 'CSS styling for dashboard panels', 'No empty container placeholders'],
      });
    }

    // 7. Testimonials / Social Proof
    units.push({
      id: 'unit-7-testimonials',
      title: 'Customer Testimonials & Social Proof',
      description: `Add customer reviews and testimonials section with customer quotes, author names, roles/companies, and 5-star ratings for ${targetBrand}.`,
      category: 'component',
      dependencies: units.length > 0 ? [units[units.length - 1].id] : [],
      targetFiles: ['index.html', 'styles.css'],
      expectedOutput: 'Testimonials section with at least 3 distinct customer review cards with author avatars/ratings.',
      verificationCriteria: ['testimonials section exists', 'At least 2 testimonial cards with realistic quotes'],
    });

    // 8. Pricing & Plans
    if (lower.includes('pricing') || lower.includes('plan') || lower.includes('saas') || lower.includes('nexora') || complexity === 'high') {
      units.push({
        id: 'unit-8-pricing',
        title: 'Tiered Pricing & Plans',
        description: `Implement tiered pricing table (e.g. Starter, Professional, Enterprise) with feature comparison lists, highlighted popular badge, and checkout CTA buttons for ${targetBrand}.`,
        category: 'component',
        dependencies: units.length > 0 ? [units[units.length - 1].id] : [],
        targetFiles: ['index.html', 'styles.css'],
        expectedOutput: 'Pricing section with 3 tier cards, feature checklists, prices ($/mo), and selection buttons.',
        verificationCriteria: ['pricing section exists with 3 pricing cards', 'Pricing numbers, features, and buttons present'],
      });
    }

    // 9. FAQ Section
    if (lower.includes('faq') || lower.includes('question') || complexity === 'high') {
      units.push({
        id: 'unit-9-faq',
        title: 'Frequently Asked Questions (FAQ)',
        description: `Build FAQ accordion section with 4 to 6 common questions and detailed answers regarding ${targetBrand}.`,
        category: 'component',
        dependencies: units.length > 0 ? [units[units.length - 1].id] : [],
        targetFiles: ['index.html', 'styles.css', 'scripts.js'],
        expectedOutput: 'FAQ accordion with 4+ questions and expandable answer panels with JavaScript toggling.',
        verificationCriteria: ['faq section exists with questions and answers', 'No skeleton or placeholder questions'],
      });
    }

    // 10. Call to Action (CTA) & Footer
    units.push({
      id: 'unit-10-cta-footer',
      title: 'Conversion CTA Banner & Complete Footer',
      description: `Create final conversion CTA section with email input / launch button, and multi-column footer with company links, copyright, social icons, and legal pages for ${targetBrand}.`,
      category: 'component',
      dependencies: units.length > 0 ? [units[units.length - 1].id] : [],
      targetFiles: ['index.html', 'styles.css'],
      expectedOutput: 'Engaging CTA banner and comprehensive 4-column footer with valid anchor links.',
      verificationCriteria: ['cta section and footer element exist', 'Copyright and navigation links present in footer'],
    });

    // 11. Responsive Styling & Dynamic Interactions
    units.push({
      id: 'unit-11-interactions',
      title: 'Responsive Design & Dynamic JavaScript',
      description: `Implement mobile navigation toggle, smooth scroll navigation, FAQ accordion click handlers, dashboard live ticker, and responsive media queries across devices.`,
      category: 'logic',
      dependencies: units.map((u) => u.id),
      targetFiles: ['styles.css', 'scripts.js', 'index.html'],
      expectedOutput: 'JavaScript interactivity for mobile menu, smooth scrolling, and accordion toggles, plus responsive CSS media queries.',
      verificationCriteria: ['scripts.js contains working DOM interaction code', 'styles.css has media queries for mobile/tablet'],
    });

    // 12. Final Project Integration & Verification
    units.push({
      id: 'unit-12-final-integration',
      title: 'Final Project Integration & Verification',
      description: `Perform complete cross-file audit: verify all sections render rich visible text, all styles and scripts are linked, and zero placeholder comments or empty shells exist in ${targetBrand}.`,
      category: 'integration',
      dependencies: units.map((u) => u.id),
      targetFiles: ['index.html', 'styles.css', 'scripts.js'],
      expectedOutput: `Complete, verified, production-grade ${targetBrand} web project ready for preview server hosting.`,
      verificationCriteria: ['All project files exist and pass integrity check', 'HTML contains rich substantive content and no skeletons'],
    });

    return {
      parentGoal: goal,
      isDecomposed: true,
      estimatedComplexity: complexity,
      reasoning: `Decomposed ${targetBrand} into ${units.length} coherent modular units spanning foundation, components, styling, logic, and final integration.`,
      units,
    };
  }

  /**
   * Extract brand name from prompt text (e.g. 'NOVARA AI', 'NEXORA', 'Bean & Brew', 'DevForge').
   */
  private extractBrandName(goal: string): string | null {
    const candidates = extractBrandCandidates(goal);
    if (candidates.length > 0) {
      return candidates[0];
    }
    return null;
  }

  private inferTargetFiles(goal: string): string[] {
    const lower = goal.toLowerCase();
    if (lower.includes('.py') || lower.includes('python')) return ['main.py'];
    if (lower.includes('.json')) return ['data.json'];
    if (lower.includes('.md') || lower.includes('readme')) return ['README.md'];
    return ['index.html', 'styles.css'];
  }

  private extractRequestedFolder(goal: string): string | null {
    const match = goal.match(/(?:folder|directory)\s+[`"']?([a-zA-Z0-9_\-]+)[`"']?/i);
    if (match && match[1]) {
      const f = match[1].trim();
      const forbidden = ['a', 'the', 'new', 'containing', 'named', 'called', 'with', 'for'];
      if (!forbidden.includes(f.toLowerCase())) {
        return f;
      }
    }
    return null;
  }

  private inferProjectFolder(goal: string): string {
    const requested = this.extractRequestedFolder(goal);
    if (requested) return requested;
    const match = goal.match(/(?:folder|directory|project)\s+[`"']?([a-zA-Z0-9_\-]+)[`"']?/i);
    if (match && match[1]) {
      return match[1].trim();
    }
    const brand = this.extractBrandName(goal);
    if (brand) {
      return brand.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    }
    return 'project';
  }
}

import crypto from 'node:crypto';

export interface IEmbeddingProvider {
  dimension: number;
  modelName: string;
  embedText(text: string): Promise<number[]>;
}

export class LocalFeatureEmbeddingProvider implements IEmbeddingProvider {
  public readonly dimension: number = 64;
  public readonly modelName: string = 'local-feature-hash-v1';

  async embedText(text: string): Promise<number[]> {
    const vector = new Array(this.dimension).fill(0);
    const cleaned = text.toLowerCase().replace(/[^\w\s]/g, ' ');
    const tokens = cleaned.split(/\s+/).filter(Boolean);

    if (tokens.length === 0) {
      return vector;
    }

    for (const token of tokens) {
      const hashHex = crypto.createHash('md5').update(token).digest('hex');
      const hashVal = parseInt(hashHex.substring(0, 8), 16);
      const index = Math.abs(hashVal) % this.dimension;
      vector[index] += 1;
    }

    // Normalize L2 vector
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] = vector[i] / norm;
      }
    }

    return vector;
  }
}

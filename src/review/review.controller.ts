import { Body, Controller, Post } from '@nestjs/common';
import { ReviewService } from './review.service.js';
import { type CreatePrDto } from './dto/create-pr.dto.js';
import { type ReviewPrDto } from './dto/review-pr.dto.js';

@Controller('review')
export class ReviewController {
  constructor(private reviewService: ReviewService) {}

  @Post('create-pr')
  createPr(@Body() dto: CreatePrDto) {
    return this.reviewService.createPullRequest(dto);
  }

  @Post('review-pr')
  reviewPr(@Body() dto: ReviewPrDto) {
    return this.reviewService.reviewPullRequest(dto);
  }
}

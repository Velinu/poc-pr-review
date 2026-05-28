import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ReviewController } from './review/review.controller';
import { ReviewService } from './review/review.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AppController, ReviewController],
  providers: [AppService, ReviewService],
})
export class AppModule {}
